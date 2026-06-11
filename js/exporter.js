// 記録のエクスポート：CSV / GPX / JSON（生エポック群＋集計値）。
// Blob + a[download] でローカル保存する（外部送信なし）。

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(label) {
  return (label || 'gnss').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

function isoOrEmpty(ms) {
  return ms != null ? new Date(ms).toISOString() : '';
}

// セッションの全サンプルを取り出す（snapshot は1点、static は生エポック群）
function collectSamples(point) {
  if (!point) return [];
  if (point.kind === 'snapshot') return point.sample ? [point.sample] : [];
  return point.samples || [];
}

// ---- CSV（BOM 付き UTF-8。Excel でそのまま開ける） ----
export function exportCSV(session, point) {
  const header = [
    'time_utc', 'lat', 'lon', 'alt_msl_m', 'fix_quality', 'fix_mode',
    'sats_used', 'sats_in_view', 'pdop', 'hdop', 'vdop', 'lat_std_m', 'lon_std_m',
    'speed_kmh', 'course_deg',
  ];
  const rows = collectSamples(point).map((s) => [
    isoOrEmpty(s.t), s.lat, s.lon, s.altMSL, s.fixQuality, s.fixMode,
    s.satsUsed, s.satsInView, s.pdop, s.hdop, s.vdop, s.latStd, s.lonStd,
    s.speedKmh, s.course,
  ].map((v) => (v == null ? '' : v)).join(','));

  const lines = [header.join(','), ...rows];

  // 静的測位は集計値もコメント行として付ける
  if (point && point.stats) {
    const st = point.stats;
    lines.push('');
    lines.push('# 集計値');
    lines.push(`# center_lat,${st.center.lat}`);
    lines.push(`# center_lon,${st.center.lon}`);
    lines.push(`# std_east_m,${st.stdEastM}`);
    lines.push(`# std_north_m,${st.stdNorthM}`);
    lines.push(`# drms_m,${st.drms}`);
    lines.push(`# 2drms_m,${st.drms2}`);
    lines.push(`# cep50_m,${st.cep50}`);
    lines.push(`# cep95_m,${st.cep95}`);
    lines.push(`# alt_mean_m,${st.altMean}`);
    lines.push(`# alt_std_m,${st.altStd}`);
    lines.push(`# epochs,${st.count}`);
  }

  download(`${safeName(session.label)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

// ---- GPX（snapshot/static中心 = wpt、staticの生エポック = trk） ----
const escXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function exportGPX(session, point) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<gpx version="1.1" creator="GNSS Tracker" xmlns="http://www.topografix.com/GPX/1/1">');

  const center =
    point?.kind === 'static' && point.stats
      ? { lat: point.stats.center.lat, lon: point.stats.center.lon, ele: point.stats.altMean, t: session.createdAt }
      : point?.sample
        ? { lat: point.sample.lat, lon: point.sample.lon, ele: point.sample.altMSL, t: point.sample.t }
        : null;

  if (center && center.lat != null) {
    parts.push(`  <wpt lat="${center.lat}" lon="${center.lon}">`);
    if (center.ele != null) parts.push(`    <ele>${center.ele}</ele>`);
    if (center.t != null) parts.push(`    <time>${isoOrEmpty(center.t)}</time>`);
    parts.push(`    <name>${escXml(session.label)}</name>`);
    if (session.memo) parts.push(`    <desc>${escXml(session.memo)}</desc>`);
    parts.push('  </wpt>');
  }

  if (point?.kind === 'static' && point.samples?.length) {
    parts.push('  <trk>');
    parts.push(`    <name>${escXml(session.label)}（生エポック）</name>`);
    parts.push('    <trkseg>');
    for (const s of point.samples) {
      if (s.lat == null) continue;
      parts.push(`      <trkpt lat="${s.lat}" lon="${s.lon}">`);
      if (s.altMSL != null) parts.push(`        <ele>${s.altMSL}</ele>`);
      parts.push(`        <time>${isoOrEmpty(s.t)}</time>`);
      parts.push('      </trkpt>');
    }
    parts.push('    </trkseg>');
    parts.push('  </trk>');
  }

  parts.push('</gpx>');
  download(`${safeName(session.label)}.gpx`, parts.join('\n'), 'application/gpx+xml');
}

// ---- JSON（セッション＋地点を丸ごと） ----
export function exportJSON(session, point) {
  const data = { session, point };
  download(`${safeName(session.label)}.json`, JSON.stringify(data, null, 2), 'application/json');
}
