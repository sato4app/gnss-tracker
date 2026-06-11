// Leaflet ＋ 地理院地図（標準 / 淡色 / 写真）。
// 現在地マーカー・水平精度円・軌跡ポリライン・記録地点マーカー・追従トグル。
// Leaflet はローカル配置（vendor/leaflet/）の script タグで読み込み、グローバル L を使う。
/* global L */

export const GSI_LAYERS = {
  std: {
    label: '標準地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  pale: {
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  photo: {
    label: '写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxZoom: 18,
  },
};

const GSI_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>';

// 初期地図中心: 箕面大滝（CLAUDE.md の規約に従う）
const DEFAULT_CENTER = [34.853667, 135.472041];
const DEFAULT_ZOOM = 17; // 既定ズーム z=17

export class MapView {
  constructor(el, { mapType = 'std', trackEnabled = true, follow = true } = {}) {
    this.map = L.map(el, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });
    this.baseLayer = null;
    this.setBaseLayer(mapType);

    this.follow = follow;
    this.trackEnabled = trackEnabled;

    this.posMarker = null; // 現在地マーカー
    this.accCircle = null; // 水平精度円
    this.track = L.polyline([], { color: '#4f9dff', weight: 3, opacity: 0.7 }).addTo(this.map);
    this.recordLayer = L.layerGroup().addTo(this.map); // 記録地点マーカー

    // ユーザーが手で地図を動かしたら追従を切る（onFollowChange で UI に通知）
    this.onFollowChange = () => {};
    this.map.on('dragstart', () => {
      if (this.follow) {
        this.follow = false;
        this.onFollowChange(false);
      }
    });
  }

  setBaseLayer(type) {
    const def = GSI_LAYERS[type] || GSI_LAYERS.std;
    if (this.baseLayer) this.map.removeLayer(this.baseLayer);
    this.baseLayer = L.tileLayer(def.url, {
      maxZoom: def.maxZoom,
      attribution: GSI_ATTRIBUTION,
    }).addTo(this.map);
  }

  setFollow(on) {
    this.follow = on;
  }

  setTrackEnabled(on) {
    this.trackEnabled = on;
    if (!on) this.track.setLatLngs([]);
  }

  // 現在地＋精度円を更新。accM は推定水平精度 [m]（null なら円を消す）
  updatePosition(lat, lon, accM) {
    const ll = [lat, lon];
    if (!this.posMarker) {
      this.posMarker = L.circleMarker(ll, {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#4f9dff',
        fillOpacity: 1,
      }).addTo(this.map);
    } else {
      this.posMarker.setLatLng(ll);
    }

    if (accM != null && accM > 0) {
      if (!this.accCircle) {
        this.accCircle = L.circle(ll, {
          radius: accM,
          color: '#4f9dff',
          weight: 1,
          fillColor: '#4f9dff',
          fillOpacity: 0.15,
        }).addTo(this.map);
      } else {
        this.accCircle.setLatLng(ll);
        this.accCircle.setRadius(accM);
      }
    } else if (this.accCircle) {
      this.map.removeLayer(this.accCircle);
      this.accCircle = null;
    }

    if (this.trackEnabled) this.track.addLatLng(ll);
    if (this.follow) this.map.panTo(ll, { animate: false });
  }

  clearTrack() {
    this.track.setLatLngs([]);
  }

  // 記録地点マーカー（snapshot=橙 / static=緑）
  addRecordMarker(lat, lon, label, type) {
    const color = type === 'static' ? '#36c98d' : '#f0a93a';
    const m = L.circleMarker([lat, lon], {
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.5,
    }).addTo(this.recordLayer);
    if (label) m.bindPopup(label);
    return m;
  }

  clearRecordMarkers() {
    this.recordLayer.clearLayers();
  }

  // 記録一覧から選んだセッションを地図に表示する
  showSessionOnMap(session) {
    const s = session.summary || {};
    if (s.lat == null || s.lon == null) return;
    this.addRecordMarker(s.lat, s.lon, session.label, session.type);
    this.follow = false;
    this.onFollowChange(false);
    this.map.setView([s.lat, s.lon], DEFAULT_ZOOM);
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}
