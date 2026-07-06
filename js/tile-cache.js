// data/tile_manifest.json（Format A：座標リスト JSON 方式）による地図タイルの事前ダウンロード。
// マニフェストは data/ を唯一の置き場とし、ルート直下には複製を置かない（重複回避）。
// マニフェスト記載タイルを Cache API（sw.js と同じ 'gsi-tiles' キャッシュ）へ一括取得する。
// オフライン時は SW がこのキャッシュからタイルを返す。
import { GSI_LAYERS } from './map.js';

const TILE_CACHE_NAME = 'gsi-tiles';

export class TileCache {
  constructor() {
    this.aborter = null;
  }

  static isSupported() {
    return typeof caches !== 'undefined';
  }

  // マニフェスト形式:
  // { layers: { <key>: { z: 17, tiles: [[x, y], ...] }, ... } }
  async loadManifest(url = 'data/tile_manifest.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} を取得できません (${res.status})`);
    return res.json();
  }

  // マニフェスト内の全タイル数（オプション層も含む）
  countTiles(manifest, { zoomFilter = null } = {}) {
    let n = 0;
    for (const layer of Object.values(manifest.layers || {})) {
      if (zoomFilter && !zoomFilter.includes(layer.z)) continue;
      n += (layer.tiles || []).length;
    }
    return n;
  }

  // マニフェスト記載のタイルを一括取得する。
  //   mapType: 'std' | 'pale' | 'photo'（URL テンプレートを切替）
  //   zoomFilter: 対象ズームの配列（null なら全層）
  //   onProgress({done, total, failed}) で進捗を通知
  async download(manifest, { mapType = 'std', zoomFilter = null, onProgress = () => {} } = {}) {
    if (!TileCache.isSupported()) throw new Error('Cache API 非対応の環境です');
    const def = GSI_LAYERS[mapType] || GSI_LAYERS.std;
    const cache = await caches.open(TILE_CACHE_NAME);
    this.aborter = new AbortController();
    const signal = this.aborter.signal;

    // 対象タイル URL を列挙
    const urls = [];
    for (const layer of Object.values(manifest.layers || {})) {
      if (zoomFilter && !zoomFilter.includes(layer.z)) continue;
      for (const [x, y] of layer.tiles || []) {
        urls.push(def.url.replace('{z}', layer.z).replace('{x}', x).replace('{y}', y));
      }
    }

    const total = urls.length;
    let done = 0;
    let failed = 0;
    const CONCURRENCY = 4; // 地理院サーバへの負荷を抑える

    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        if (signal.aborted) return;
        const url = urls[idx++];
        try {
          // キャッシュ済みはスキップ
          const hit = await cache.match(url);
          if (!hit) {
            const res = await fetch(url, { signal });
            if (res.ok) await cache.put(url, res);
            else failed++;
          }
        } catch (e) {
          if (signal.aborted) return;
          failed++;
        }
        done++;
        onProgress({ done, total, failed });
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.aborter = null;
    return { done, total, failed, cancelled: signal.aborted };
  }

  cancel() {
    if (this.aborter) this.aborter.abort();
  }

  // 現在のタイルキャッシュ件数（目安表示用）
  async cachedCount() {
    if (!TileCache.isSupported()) return 0;
    const cache = await caches.open(TILE_CACHE_NAME);
    const keys = await cache.keys();
    return keys.length;
  }
}
