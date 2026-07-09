// 情報タブの UI 配線。
// Service Worker のキャッシュバージョンを「現行（動作中のSW）」と「最新（サーバー上の sw.js）」で
// 表示し、差があればアプリ更新（新SWの有効化＋再読み込み）を confirm で確認する。
// sw.js は skipWaiting + clients.claim のため、ページ表示中に新SWへ自動で切り替わることがある。
// その場合も controllerchange で検知して再読み込みを confirm する。
const VERSION_RE = /SHELL_CACHE\s*=\s*'(gnss-shell-[^']+)'/;

export function initInfoUI({ $ }) {
  let confirmedVersion = null; // 同じバージョンで confirm を繰り返さないため
  let updating = false; // 「アプリを更新」実行中（controllerchange で即リロードする）
  let needsReload = false; // 新SWは有効化済みだが、ページの再読み込みを保留している状態

  // ページ表示中に新SWが制御を握った（＝更新が適用された）ときの検知。
  // 初回インストールやハードリロード直後（未制御で開始）は clients.claim でも
  // controllerchange が発火するが、ページ自体が新しいので確認不要。
  const hadController = !!navigator.serviceWorker?.controller;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updating) {
        location.reload();
        return;
      }
      if (!hadController) return;
      needsReload = true;
      if (confirm('アプリが新しいバージョンに更新されました。再読み込みして反映しますか？')) {
        location.reload();
      }
    });
  }

  // 現行バージョン：動作中のSWに postMessage で問い合わせる。
  // 旧SW（応答ハンドラなし）はタイムアウトするため、シェルキャッシュ名でフォールバック。
  async function getCurrentVersion() {
    if (!('serviceWorker' in navigator)) return null;
    const ctrl = navigator.serviceWorker.controller;
    if (ctrl) {
      const version = await new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1500);
        ch.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(e.data?.version || null);
        };
        ctrl.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      });
      if (version) return version;
    }
    try {
      const keys = (await caches.keys()).filter((k) => k.startsWith('gnss-shell-'));
      // 新旧が同居する一瞬は古い方（＝制御中のSW）を採用する
      const num = (k) => parseInt(k.match(/v(\d+)$/)?.[1] ?? '0', 10);
      keys.sort((a, b) => num(a) - num(b));
      return keys[0] || null;
    } catch (e) {
      return null;
    }
  }

  // 最新バージョン：サーバー上の sw.js を取得して SHELL_CACHE 定数を読む。
  // クエリ付き＋no-store で、SWのキャッシュにもHTTPキャッシュにも当てない。
  async function getLatestVersion() {
    const res = await fetch(`sw.js?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.text()).match(VERSION_RE);
    return m ? m[1] : null;
  }

  // 更新の適用：SWの更新チェックを起動し、新SWが有効化されたら再読み込み。
  async function applyUpdate() {
    if (updating) return;
    if (needsReload) {
      location.reload();
      return;
    }
    updating = true;
    $('btn-update-apply').hidden = true;
    $('info-update-state').textContent = '更新中…（新しいバージョンの取得が完了すると再読み込みします）';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        location.reload();
        return;
      }
      // 新SWは install 内の skipWaiting で自動的に有効化され、controllerchange で再読み込みされる
      await reg.update();
    } catch (e) {
      updating = false;
      $('btn-update-apply').hidden = false;
      $('info-update-state').textContent = `更新に失敗しました: ${e.message}`;
    }
  }

  // バージョン表示の更新。askConfirm=true なら更新検出時に confirm する（タブを開いたとき）。
  async function refresh({ askConfirm = true } = {}) {
    const stateEl = $('info-update-state');
    const applyBtn = $('btn-update-apply');
    if (updating) return;
    stateEl.textContent = '確認中…';
    applyBtn.hidden = true;

    const current = await getCurrentVersion();
    $('info-sw-current').textContent = current || '不明';

    let latest = null;
    try {
      latest = await getLatestVersion();
    } catch (e) {
      $('info-sw-latest').textContent = '取得失敗';
      stateEl.textContent = '最新バージョンを取得できませんでした（オフラインの可能性があります）。';
      return;
    }
    $('info-sw-latest').textContent = latest || '不明';
    if (!latest) {
      stateEl.textContent = 'sw.js からバージョンを読み取れませんでした。';
      return;
    }

    if (needsReload) {
      // 新SWは適用済み。再読み込みだけが未実施
      stateEl.textContent = '新しいバージョンが適用済みです。再読み込みで反映されます。';
      applyBtn.textContent = '再読み込み';
      applyBtn.hidden = false;
      return;
    }
    if (!current) {
      stateEl.textContent = '現行バージョンを取得できませんでした（初回起動直後の可能性があります）。';
      return;
    }
    if (latest === current) {
      stateEl.textContent = '最新の状態です。';
      return;
    }

    stateEl.textContent = '新しいバージョンがあります。';
    applyBtn.textContent = 'アプリを更新';
    applyBtn.hidden = false;
    if (askConfirm && confirmedVersion !== latest) {
      confirmedVersion = latest; // キャンセルされたら次回タブを開いても confirm しない（ボタンから更新可能）
      if (confirm(`新しいバージョン（${latest}）があります。アプリを更新しますか？`)) {
        await applyUpdate();
      }
    }
  }

  $('btn-update-check').addEventListener('click', () => refresh({ askConfirm: true }));
  $('btn-update-apply').addEventListener('click', () => applyUpdate());

  return { refresh };
}
