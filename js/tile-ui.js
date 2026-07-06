// オフライン地図タイルの事前ダウンロード UI 配線。
// 進捗表示・キャンセル・ダウンロード済み枚数/version の表示を担当する。
// 実際の取得は tile-cache.js（TileCache）が行う。
import { GSI_LAYERS } from './map.js';

const mapLabel = (type) => GSI_LAYERS[type]?.label || type || '標準地図';

// getMapType: 現在の地図種別を返す関数（設定変更に追従するため関数で受ける）
export function initTileUI({ $, tileCache, storage, getMapType }) {
  const progressEl = $('tiledl-progress');

  // ダウンロード済みタイルの枚数と、data/tile_manifest.json の version を表示。
  // version・地図種別・取得日時はダウンロード時に IndexedDB(settings) へ記録した値を使う
  // （オフライン起動でもネットワーク無しで表示できる）。枚数は実キャッシュ件数。
  async function refreshTileStatus() {
    const count = await tileCache.cachedCount();
    const meta = await storage.getSetting('tileCacheMeta', null);
    const el = $('tile-status');
    if (!count) {
      el.textContent = 'ダウンロード済みタイル: なし';
      return;
    }
    let text = `ダウンロード済みタイル: ${count} 枚`;
    if (meta?.version) text += ` ／ version ${meta.version}`;
    if (meta?.mapType) text += `（${mapLabel(meta.mapType)}）`;
    if (meta?.downloadedAt) text += `　${new Date(meta.downloadedAt).toLocaleString('ja-JP')} 取得`;
    el.textContent = text;
  }

  $('btn-tiledl').addEventListener('click', async () => {
    const mapType = getMapType();
    let manifest;
    try {
      manifest = await tileCache.loadManifest();
    } catch (e) {
      progressEl.textContent = `マニフェスト読込失敗: ${e.message}`;
      return;
    }
    const total = tileCache.countTiles(manifest);
    if (!total) {
      progressEl.textContent = 'マニフェストにタイルがありません';
      return;
    }
    if (!confirm(`${total} 枚のタイルをダウンロードしますか？（${mapLabel(mapType)}）`)) return;

    $('btn-tiledl').disabled = true;
    $('btn-tiledl-cancel').hidden = false;
    try {
      const result = await tileCache.download(manifest, {
        mapType,
        onProgress: ({ done, failed }) => {
          progressEl.textContent = `ダウンロード中… ${done}/${total}${failed ? `（失敗 ${failed}）` : ''}`;
        },
      });
      progressEl.textContent = result.cancelled
        ? `中止しました（${result.done}/${result.total}）`
        : `完了: ${result.done}/${result.total}${result.failed ? `（失敗 ${result.failed}）` : ''}`;
      // 1枚でも取得できたら、その時点の data/tile_manifest.json の version を記録する
      if (result.done > 0) {
        await storage.setSetting('tileCacheMeta', {
          version: manifest.version ?? null,
          mapType,
          downloadedAt: Date.now(),
          downloaded: result.done,
          cancelled: result.cancelled,
        });
      }
      await refreshTileStatus();
    } catch (e) {
      progressEl.textContent = `エラー: ${e.message}`;
    } finally {
      $('btn-tiledl').disabled = false;
      $('btn-tiledl-cancel').hidden = true;
    }
  });

  $('btn-tiledl-cancel').addEventListener('click', () => tileCache.cancel());

  refreshTileStatus();
}
