// Service Worker：アプリシェルのプリキャッシュ＋地理院地図タイルのキャッシュ。
// タイルは cache-first（オフラインでもキャッシュ済範囲の地図が出る）。
// タイルキャッシュ名は js/tile-cache.js の事前ダウンロードと共有する。
const SHELL_CACHE = 'gnss-shell-v2';
const TILE_CACHE = 'gsi-tiles';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/ble-client.js',
  './js/nmea-parser.js',
  './js/line-buffer.js',
  './js/epoch-assembler.js',
  './js/accuracy.js',
  './js/map.js',
  './js/sky-plot.js',
  './js/snr-chart.js',
  './js/scatter-plot.js',
  './js/recorder.js',
  './js/storage.js',
  './js/exporter.js',
  './js/wake-lock.js',
  './js/tile-cache.js',
  './js/mock-feeder.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('gnss-shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 地理院地図タイル：cache-first。未キャッシュ時のみ取得し TILE_CACHE へ格納。
  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          // オフラインで未キャッシュ → 透明扱いのエラー応答（Leaflet 側でグレー表示）
          return new Response('', { status: 504, statusText: 'tile offline' });
        }
      })
    );
    return;
  }

  // アプリシェル（同一オリジン GET）：cache-first＋ネットワークフォールバック
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            // data/tile_manifest.json など後から取得するファイルもシェルキャッシュに足す
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
      )
    );
  }
});
