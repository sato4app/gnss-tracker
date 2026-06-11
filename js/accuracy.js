// GNSS 精度の算出：水平精度推定（GST / HDOP×UERE）、
// 静的測位の集計（平均・標準偏差・DRMS・CEP50/CEP95 など）。
// 緯度経度 ↔ メートル換算は局所平面近似（緯度に応じた 1度あたり m）で行う。

// 緯度 lat[deg] における 1度あたりのメートル（局所平面近似で十分）
export function metersPerDegree(lat) {
  const rad = (lat * Math.PI) / 180;
  return {
    latM: 111320, // 南北方向
    lonM: 111320 * Math.cos(rad), // 東西方向
  };
}

// 水平精度の推定（優先順）:
//   1. GST があれば lat/lon 標準偏差から DRMS
//   2. 無ければ HDOP × UERE（UERE は設定値、既定 5 m）で概算
// 戻り値: { value: m, source: 'GST' | 'HDOP×UERE' } または null
export function estimateHorizontalAccuracy(epoch, uere = 5) {
  if (epoch.latStd != null && epoch.lonStd != null) {
    return {
      value: Math.sqrt(epoch.latStd ** 2 + epoch.lonStd ** 2),
      source: 'GST',
    };
  }
  if (epoch.hdop != null) {
    return { value: epoch.hdop * uere, source: 'HDOP×UERE' };
  }
  return null;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu != null ? mu : mean(arr);
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
}

// ソート済み半径誤差列から経験的パーセンタイル（線形補間）
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// 静的測位の集計。epochs は lat/lon を持つエポック群（fix のあるもの）。
// 戻り値（仕様 3-6 (B) の集計指標一式）:
//   center {lat, lon}・median {lat, lon}・stdEastM/stdNorthM・drms/drms2・
//   cep50/cep95・altMean/altStd・count・fixCounts・avgDop・avgSats・
//   offsets [{e, n}](散布図用：中心からの東西/南北オフセット m)
export function computeStaticStats(epochs) {
  const pts = epochs.filter((e) => e.lat != null && e.lon != null);
  if (!pts.length) return null;

  const lats = pts.map((e) => e.lat);
  const lons = pts.map((e) => e.lon);
  const latMean = mean(lats);
  const lonMean = mean(lons);
  const { latM, lonM } = metersPerDegree(latMean);

  // 中心からの東西(E)/南北(N)オフセット [m]
  const offsets = pts.map((e) => ({
    e: (e.lon - lonMean) * lonM,
    n: (e.lat - latMean) * latM,
  }));

  const stdNorthM = stddev(offsets.map((o) => o.n), 0);
  const stdEastM = stddev(offsets.map((o) => o.e), 0);
  const drms = Math.sqrt(stdNorthM ** 2 + stdEastM ** 2);

  // CEP50/CEP95 は中心からの半径誤差の経験的パーセンタイル（実測ばらつき）
  const radii = offsets.map((o) => Math.sqrt(o.e ** 2 + o.n ** 2)).sort((a, b) => a - b);

  const alts = pts.map((e) => e.altMSL).filter((v) => v != null);
  const altMean = mean(alts);

  const fixCounts = {};
  for (const e of pts) {
    const q = e.fixQuality != null ? e.fixQuality : '-';
    fixCounts[q] = (fixCounts[q] || 0) + 1;
  }

  const dops = { pdop: [], hdop: [], vdop: [] };
  const sats = [];
  for (const e of pts) {
    if (e.pdop != null) dops.pdop.push(e.pdop);
    if (e.hdop != null) dops.hdop.push(e.hdop);
    if (e.vdop != null) dops.vdop.push(e.vdop);
    if (e.satsUsed != null) sats.push(e.satsUsed);
  }

  return {
    count: pts.length,
    center: { lat: latMean, lon: lonMean },
    median: { lat: median(lats), lon: median(lons) },
    stdEastM,
    stdNorthM,
    drms,
    drms2: drms * 2,
    cep50: percentile(radii, 0.5),
    cep95: percentile(radii, 0.95),
    altMean,
    altStd: alts.length ? stddev(alts, altMean) : null,
    fixCounts,
    avgPdop: mean(dops.pdop),
    avgHdop: mean(dops.hdop),
    avgVdop: mean(dops.vdop),
    avgSats: mean(sats),
    offsets,
  };
}
