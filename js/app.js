// エントリ：各モジュールの結線。
// データフロー: BLE/Mock → LineBuffer → nmea-parser → EpochAssembler
//             → (地図 / ライブ表示 / 解析 / 記録) ※再描画は rAF でスロットリング
// 行・エポックは StreamStats（受信品質統計）にも分岐する。$PPICO は統計のみ。
import { LineBuffer } from './line-buffer.js';
import { parseSentence, CONSTELLATION_COLORS, CONSTELLATION_LABELS } from './nmea-parser.js';
import { EpochAssembler } from './epoch-assembler.js';
import { StreamStats } from './stream-stats.js';
import { NmeaBle } from './ble-client.js';
import { MockFeeder } from './mock-feeder.js';
import { estimateHorizontalAccuracy } from './accuracy.js';
import { MapView } from './map.js';
import { SkyPlotView } from './sky-plot.js';
import { SnrChartView } from './snr-chart.js';
import { ScatterPlotView } from './scatter-plot.js';
import { Storage } from './storage.js';
import { Recorder } from './recorder.js';
import { exportCSV, exportGPX, exportJSON } from './exporter.js';
import { WakeLockManager } from './wake-lock.js';
import { TileCache } from './tile-cache.js';
import { fmt, escapeHtml, FIX_MODE, fixBadge, formatStats, sessionSubText, nextPointLabel } from './format.js';
import { initSettingsUI } from './settings-ui.js';
import { initTileUI } from './tile-ui.js';

const $ = (id) => document.getElementById(id);

// ---- 設定（IndexedDB settings ストアに永続化） ----
const DEFAULT_SETTINGS = {
  uere: 5, // HDOP×UERE 概算用 [m]
  staticMaxSec: 60, // 静的測位の上限時間（タイムアウト）
  staticMaxEpochs: 120, // 静的測位の上限エポック数
  staticAutoStop: true, // 収束（中心・DRMS横ばい）による自動停止
  staticMinSec: 30, // 静的測位の最低収集時間
  mapType: 'std',
  trackEnabled: true,
};

async function main() {
  const storage = new Storage();
  await storage.init();

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = await storage.getSetting(key, DEFAULT_SETTINGS[key]);
  }

  // ---- ビュー ----
  const mapView = new MapView($('map'), {
    mapType: settings.mapType,
    trackEnabled: settings.trackEnabled,
    follow: true,
  });
  const skyView = new SkyPlotView($('sky-plot'));
  const snrView = new SnrChartView($('snr-chart'));
  const scatterView = new ScatterPlotView($('scatter'));
  const wakeLock = new WakeLockManager({
    onChange: (active, msg) => {
      $('wakelock-state').textContent = `Wake Lock: ${msg}`;
    },
  });
  const tileCache = new TileCache();

  // ---- 受信品質統計（M10S→Pico→BLE→アプリの取りこぼし確認） ----
  const streamStats = new StreamStats();

  // ---- 記録 ----
  const recorder = new Recorder(storage, {
    getRxStats: () => streamStats.snapshot(), // 測定1回分の受信品質を summary に残す
    onStaticUpdate: ({ count, elapsedSec, stats, convergence }) => {
      $('st-count').textContent = String(count);
      $('st-elapsed').textContent = `${Math.floor(elapsedSec)} s`;
      $('st-drms').textContent = stats ? `${stats.drms.toFixed(2)} m` : '—';
      $('st-cep').textContent = stats && stats.cep50 != null ? `${stats.cep50.toFixed(2)} m` : '—';
      // 収束判定の状況（docs/static-autostop-202607.md 5.）
      const convEl = $('st-conv');
      if (!settings.staticAutoStop) {
        convEl.textContent = '—（自動停止OFF）';
      } else if (elapsedSec < settings.staticMinSec) {
        convEl.textContent = `最低時間まで残り ${Math.max(0, Math.ceil(settings.staticMinSec - elapsedSec))} 秒`;
      } else if (!convergence) {
        convEl.textContent = '待機中（品質不足）';
      } else if (convergence.centerMoveM == null) {
        convEl.textContent = '判定中（安定10秒待ち）';
      } else {
        convEl.textContent = `安定 ${convergence.centerMoveM.toFixed(1)} m / DRMS±${convergence.drmsRangeM.toFixed(1)} m`;
      }
      if (stats) scatterView.update(stats);
    },
    onStaticStop: async (session) => {
      // 自動停止（N秒/Mエポック到達）でもUIを確実に戻す
      await onStaticStopped(session);
    },
  });

  // ---- エポック組み立て → 各表示の更新（rAF スロットリング） ----
  let latestEpoch = null;
  let renderQueued = false;

  const assembler = new EpochAssembler({
    onEpoch: (epoch) => {
      streamStats.addEpoch(epoch); // エポック数・時刻ギャップ・GSV欠落を集計
      latestEpoch = epoch;
      recorder.addEpoch(epoch);
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(() => {
          renderQueued = false;
          if (latestEpoch) render(latestEpoch);
        });
      }
    },
  });

  const lineBuffer = new LineBuffer({ onDiscard: (chars) => streamStats.noteDiscard(chars) });
  let lastRxAt = null;

  function handleFrame(frame) {
    lastRxAt = Date.now();
    for (const line of lineBuffer.push(frame)) {
      const parsed = parseSentence(line);
      if (streamStats.addLine(parsed)) continue; // $PPICO は統計のみ（エポックへ回さない）
      assembler.add(parsed); // チェックサム不正は valid:false → 計数して捨てる
    }
  }

  // ---- 接続状態表示 ----
  const STATUS_LABELS = {
    disconnected: '未接続',
    connecting: '接続処理中…',
    reconnecting: '再接続中…',
    connected: '接続中',
    receiving: '受信中',
    demo: 'モック配信中',
    unsupported: 'BLE非対応',
  };

  let ble = null;
  let mock = null;
  let connState = 'disconnected';

  function setConnStatus(state) {
    connState = state;
    const el = $('conn-status');
    el.dataset.state = state;
    el.textContent = STATUS_LABELS[state] || state;
    $('btn-connect').textContent = state === 'disconnected' || state === 'unsupported' ? '接続' : '切断';
    // 地図のみのメイン画面でも接続状態が分かるよう、下部「接続」ボタンのドットへ反映
    $('conn-dot').dataset.state = state;
  }

  // ---- 受信品質パネル（接続タブ）の描画 ----
  function renderRxStats() {
    const s = streamStats;
    $('rx-lines').textContent = `${s.lines} / ${s.csNg}`;
    $('rx-unknown').textContent = `${s.unknown} / ${s.discardedChars}`;
    $('rx-epochs').textContent = `${s.epochs} / ${s.epochGaps}`;
    $('rx-gsv').textContent = String(s.gsvMissing);
    $('rx-ble').textContent = s.bleLossEst == null ? '—' : `${s.bleLossEst} 行`;
    if (s.pico) {
      $('rx-ppico').textContent = `#${s.pico.seq}（欠落 ${s.picoSeqGaps}）`;
      $('rx-pico-uart').textContent = `${s.pico.rx} / ${s.pico.ng}`;
      $('rx-pico-drop').textContent = `${s.pico.drop} / ${s.pico.txng}`;
    } else {
      $('rx-ppico').textContent = '未受信';
      $('rx-pico-uart').textContent = '—';
      $('rx-pico-drop').textContent = '—';
    }
  }

  $('btn-rxstats-reset').addEventListener('click', () => {
    streamStats.reset();
    renderRxStats();
  });

  // 接続中＋データが流れていれば「受信中」へ昇格、最終受信経過も表示
  setInterval(() => {
    renderRxStats();
    if (lastRxAt == null) {
      $('last-recv').textContent = '—';
      return;
    }
    const sec = Math.floor((Date.now() - lastRxAt) / 1000);
    $('last-recv').textContent = `${sec}s前`;
    if (connState === 'connected' && sec <= 3) setConnStatus('receiving');
    else if (connState === 'receiving' && sec > 3) setConnStatus('connected');
  }, 1000);

  // ---- BLE 接続ボタン（requestDevice はユーザー操作内で呼ぶ） ----
  $('btn-connect').addEventListener('click', async () => {
    if (ble && ble.shouldRun) {
      ble.disconnect(); // 手動切断（自動再接続しない）
      ble = null;
      assembler.flush();
      setConnStatus('disconnected');
      return;
    }
    const reason = NmeaBle.unavailableReason();
    if (reason) {
      alert(reason + '\n（実機なしの場合は設定タブの「モックNMEA配信」をご利用ください）');
      return;
    }
    stopMock();
    streamStats.reset(); // 新しい接続 = 新しい測定区間として統計を取り直す
    renderRxStats();
    ble = new NmeaBle({
      onFrame: handleFrame,
      onStatus: (s) => {
        // 受信中表示はタイマー側で管理するため connected を上書きしない
        if (!(s === 'connected' && connState === 'receiving')) setConnStatus(s);
      },
    });
    await ble.connect();
    if (!ble.shouldRun) {
      ble = null;
      setConnStatus('disconnected');
    }
  });

  // ---- モック（開発用） ----
  function startMock() {
    if (mock) return;
    if (ble) {
      ble.disconnect();
      ble = null;
    }
    streamStats.reset();
    renderRxStats();
    mock = new MockFeeder(handleFrame);
    mock.start();
    setConnStatus('demo');
  }

  function stopMock() {
    if (!mock) return;
    mock.stop();
    mock = null;
    assembler.flush();
    if (!ble) setConnStatus('disconnected');
    $('set-mock').checked = false;
  }

  $('set-mock').addEventListener('change', (e) => {
    if (e.target.checked) startMock();
    else stopMock();
  });

  // ---- 表示更新（1エポックごと。rAF 経由） ----
  function render(epoch) {
    // fix バッジ：GGA quality と GSA fixMode を組み合わせる（判定は format.js）
    const badge = fixBadge(epoch);
    const badgeEl = $('fix-badge');
    badgeEl.textContent = badge.t;
    badgeEl.className = `fix-badge ${badge.cls}`;

    // 水平精度（GST 優先 / HDOP×UERE フォールバック）
    const acc = estimateHorizontalAccuracy(epoch, settings.uere);

    // ライブタブ
    $('lv-lat').textContent = epoch.lat != null ? epoch.lat.toFixed(6) : '—';
    $('lv-lon').textContent = epoch.lon != null ? epoch.lon.toFixed(6) : '—';
    $('lv-alt').textContent = fmt(epoch.altMSL, 1, ' m');
    $('lv-acc').textContent = acc ? `±${acc.value.toFixed(1)} m (${acc.source})` : '—';
    $('lv-speed').textContent = fmt(epoch.speedKmh, 1, ' km/h');
    $('lv-course').textContent = fmt(epoch.course, 0, '°');
    $('lv-sats').textContent =
      epoch.satsUsed != null || epoch.satsInView != null
        ? `${epoch.satsUsed ?? '—'} / ${epoch.satsInView ?? '—'}`
        : '—';
    $('lv-time').textContent = epoch.time?.str || '—';

    // 系統別内訳チップ
    const sysIds = new Set([...Object.keys(epoch.usedBySys || {}), ...Object.keys(epoch.inViewBySys || {})]);
    if (sysIds.size) {
      $('lv-sys').innerHTML = [...sysIds]
        .map((sys) => {
          const color = CONSTELLATION_COLORS[sys] || CONSTELLATION_COLORS.unknown;
          const label = CONSTELLATION_LABELS[sys] || sys;
          const used = epoch.usedBySys[sys] || 0;
          const inView = epoch.inViewBySys[sys] || '—';
          return `<span class="sys-chip"><i class="swatch" style="background:${color}"></i>${label} ${used}/${inView}</span>`;
        })
        .join('');
    }

    // DOP（数値＋バー。6以上で満タン扱い）
    for (const k of ['pdop', 'hdop', 'vdop']) {
      $(`lv-${k}`).textContent = fmt(epoch[k]);
      $(`an-${k}`).textContent = fmt(epoch[k]);
      const v = epoch[k];
      const bar = $(`bar-${k}`);
      if (v != null) {
        bar.style.width = `${Math.min(v / 6, 1) * 100}%`;
        bar.style.background = v < 2 ? 'var(--good)' : v < 4 ? 'var(--warn)' : 'var(--bad)';
      } else {
        bar.style.width = '0';
      }
    }

    // 解析タブ
    $('an-mode').textContent = FIX_MODE[epoch.fixMode] || '—';
    $('an-accsrc').textContent = acc ? acc.source : '—';
    $('an-gst').textContent =
      epoch.latStd != null ? `${epoch.latStd.toFixed(2)} / ${epoch.lonStd.toFixed(2)} m` : '出力なし';
    skyView.update(epoch);
    snrView.update(epoch);

    // 地図
    if (epoch.lat != null && epoch.lon != null && epoch.fixQuality > 0) {
      mapView.updatePosition(epoch.lat, epoch.lon, acc ? acc.value : null);
    }
  }

  // ---- 凡例 ----
  $('legend').innerHTML = Object.entries(CONSTELLATION_LABELS)
    .filter(([id]) => id !== 'unknown' && id !== 'mixed')
    .map(([id, label]) => `<span><i class="swatch" style="background:${CONSTELLATION_COLORS[id]}"></i>${label}</span>`)
    .join('');

  // ---- 下部ボタン → オーバーレイ開閉 ----
  const PAGE_TITLES = { connect: '接続', live: 'ライブ', analysis: '解析', record: '記録', settings: '設定' };
  const overlayEl = $('overlay');
  let activePage = null;

  function openOverlay(page) {
    activePage = page;
    document.querySelectorAll('.tab-page').forEach((p) => {
      p.hidden = p.id !== `page-${page}`;
    });
    $('overlay-title').textContent = PAGE_TITLES[page] || '';
    overlayEl.hidden = false;
    document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    if (page === 'record') refreshSessionList();
    // 表示直後はキャンバスのサイズが確定しているので、最新エポックで即再描画する
    if (latestEpoch) requestAnimationFrame(() => latestEpoch && render(latestEpoch));
  }

  function closeOverlay() {
    overlayEl.hidden = true;
    activePage = null;
    document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.remove('active'));
  }

  document.querySelectorAll('#tabbar .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (activePage === page) closeOverlay(); // 同じボタンの再タップで閉じる
      else openOverlay(page);
    });
  });

  $('overlay-close').addEventListener('click', closeOverlay);
  // シート外（暗転部分）のタップで閉じる
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeOverlay();
  });

  // ---- 追従トグル ----
  $('btn-follow').addEventListener('click', () => {
    const on = !mapView.follow;
    mapView.setFollow(on);
    $('btn-follow').classList.toggle('active', on);
  });
  mapView.onFollowChange = (on) => $('btn-follow').classList.toggle('active', on);

  // ---- 記録：スナップショット ----
  $('btn-snapshot').addEventListener('click', async () => {
    try {
      const session = await recorder.saveSnapshot({
        label: $('rec-label').value.trim(),
        memo: $('rec-memo').value.trim(),
      });
      const s = session.summary;
      mapView.addRecordMarker(s.lat, s.lon, session.label, 'snapshot');
      $('static-result').textContent = `スナップショット保存: ${session.label}\n(${s.lat.toFixed(6)}, ${s.lon.toFixed(6)})`;
      $('rec-label').value = '';
      $('rec-memo').value = '';
      await refreshSessionList();
    } catch (e) {
      alert(e.message);
    }
  });

  // ---- 記録：静的測位 ----
  $('btn-static').addEventListener('click', async () => {
    if (recorder.isStaticRunning) {
      await recorder.stopStatic(); // onStaticStop 経由で UI 更新
      return;
    }
    if (!latestEpoch || latestEpoch.lat == null) {
      alert('有効な測位データがありません。接続（またはモック）を開始してください。');
      return;
    }
    // 測定開始前に地点名を確認する（既定名: yyyy-mm-dd-xx の同日連番）
    const sessions = await storage.getSessions();
    const defaultLabel = $('rec-label').value.trim() || nextPointLabel(sessions.map((s) => s.label));
    const input = prompt('地点名を入力してください', defaultLabel);
    if (input == null) return; // キャンセル → 測定を開始しない
    recorder.startStatic({
      label: input.trim() || defaultLabel,
      memo: $('rec-memo').value.trim(),
      maxSec: settings.staticMaxSec,
      maxEpochs: settings.staticMaxEpochs,
      autoStop: settings.staticAutoStop,
      minSec: settings.staticMinSec,
    });
    $('btn-static').textContent = '⏹ 静的測位 停止';
    $('btn-static').classList.add('danger');
    $('static-live').hidden = false;
    $('static-result').textContent = '';
    scatterView.clear();
    await wakeLock.acquire(); // 記録中は画面を維持（仕様 3-7）
  });

  async function onStaticStopped(session) {
    $('btn-static').textContent = '⏺ 静的測位 開始';
    $('btn-static').classList.remove('danger');
    $('static-live').hidden = true;
    $('rec-label').value = '';
    $('rec-memo').value = '';
    await wakeLock.release();

    const points = await storage.getPointsBySession(session.id);
    const stats = points[0]?.stats;
    if (stats) {
      scatterView.update(stats);
      mapView.addRecordMarker(stats.center.lat, stats.center.lon, session.label, 'static');
      $('static-result').textContent = formatStats(session, stats);
    } else {
      $('static-result').textContent = '有効なエポックが収集できませんでした';
    }
    await refreshSessionList();
  }

  // ---- 記録一覧 ----
  async function refreshSessionList() {
    const sessions = await storage.getSessions();
    const ul = $('session-list');
    ul.innerHTML = '';
    if (!sessions.length) {
      ul.innerHTML = '<li class="s-sub">記録はまだありません</li>';
      return;
    }
    for (const session of sessions) {
      const li = document.createElement('li');
      const typeLabel = session.type === 'static' ? '静的' : '地点';
      li.innerHTML = `
        <div class="s-head">
          <span class="s-type ${session.type}">${typeLabel}</span>
          <span class="s-label">${escapeHtml(session.label)}</span>
        </div>
        <div class="s-sub">${sessionSubText(session)}</div>
        <div class="s-actions">
          <button class="btn" data-act="map">地図</button>
          <button class="btn" data-act="csv">CSV</button>
          <button class="btn" data-act="gpx">GPX</button>
          <button class="btn" data-act="json">JSON</button>
          <button class="btn danger" data-act="del">削除</button>
        </div>`;
      li.querySelector('.s-actions').addEventListener('click', async (ev) => {
        const act = ev.target.dataset?.act;
        if (!act) return;
        if (act === 'del') {
          if (!confirm(`「${session.label}」を削除しますか？`)) return;
          await storage.deleteSession(session.id);
          await refreshSessionList();
          return;
        }
        if (act === 'map') {
          mapView.showSessionOnMap(session);
          // 静的測位は散布図・集計も再表示
          if (session.type === 'static') {
            const pts = await storage.getPointsBySession(session.id);
            if (pts[0]?.stats) {
              scatterView.update(pts[0].stats);
              $('static-result').textContent = formatStats(session, pts[0].stats);
            }
          }
          return;
        }
        const points = await storage.getPointsBySession(session.id);
        const point = points[0] || null;
        if (act === 'csv') exportCSV(session, point);
        else if (act === 'gpx') exportGPX(session, point);
        else if (act === 'json') exportJSON(session, point);
      });
      ul.appendChild(li);
    }
  }

  // ---- 画面 OFF / バックグラウンド → 記録一時停止（仕様 3-7） ----
  document.addEventListener('visibilitychange', () => {
    recorder.setPaused(document.hidden);
    if (!document.hidden) mapView.invalidateSize();
  });

  // ---- 設定タブ / タイル事前ダウンロード（UI 配線は各モジュールへ委譲） ----
  initSettingsUI({ $, settings, storage, mapView, defaults: DEFAULT_SETTINGS });
  initTileUI({ $, tileCache, storage, getMapType: () => settings.mapType });

  // ---- Service Worker 登録（PWA / オフライン） ----
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => {
      console.warn('Service Worker 登録失敗:', e);
    });
  }

  setConnStatus('disconnected');
}

main();
