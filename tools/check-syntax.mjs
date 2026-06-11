// 開発用：ESモジュールの構文チェック＋純粋ロジック（パーサ/エポック/精度計算）の簡易テスト。
// 使い方: node tmp/check-syntax.mjs
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const jsDir = resolve(import.meta.dirname, '../js');
// DOM 依存のモジュールは import 時に window 等へ触らない設計だが、
// Leaflet グローバル L を参照しない純粋系のみ動作テストする。
let failed = 0;

for (const f of readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
  if (f === 'app.js') continue; // app.js はトップレベルで main() 実行のためスキップ（構文はSWAテストで担保）
  try {
    await import(pathToFileURL(resolve(jsDir, f)).href);
    console.log(`OK   ${f}`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      failed++;
      console.error(`NG   ${f}: ${e.message}`);
    } else {
      // ReferenceError(window/document/navigator/indexedDB) は構文OKの証拠なので許容
      console.log(`OK   ${f} (実行時依存: ${e.constructor.name})`);
    }
  }
}

// app.js は import を試み、SyntaxError のみ NG 扱い（実行時のDOM依存エラーは許容）
try {
  await import(pathToFileURL(resolve(jsDir, 'app.js')).href).catch((e) => {
    if (e instanceof SyntaxError) throw e;
    console.log(`OK   app.js (実行時依存: ${e.constructor.name})`);
  });
} catch (e) {
  failed++;
  console.error(`NG   app.js: ${e.message}`);
}

// ---- 純粋ロジックの簡易テスト ----
const { parseSentence, validateChecksum } = await import(pathToFileURL(resolve(jsDir, 'nmea-parser.js')).href);
const { computeStaticStats, estimateHorizontalAccuracy, metersPerDegree } = await import(
  pathToFileURL(resolve(jsDir, 'accuracy.js')).href
);
const { LineBuffer } = await import(pathToFileURL(resolve(jsDir, 'line-buffer.js')).href);

function assert(cond, msg) {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
}

// チェックサム
const gga = '$GNGGA,123456.00,3451.2200,N,13528.3225,E,1,12,0.8,93.5,M,38.0,M,,*7A';
function cs(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return body && `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}
const ggaLine = cs('GNGGA,123456.00,3451.2200,N,13528.3225,E,1,12,0.8,93.5,M,38.0,M,,');
assert(validateChecksum(ggaLine), 'チェックサム検証');
assert(!validateChecksum(ggaLine.slice(0, -1) + '0'), '不正チェックサムを棄却');

const p = parseSentence(ggaLine);
assert(p.valid && p.type === 'GGA', 'GGAパース');
assert(Math.abs(p.lat - (34 + 51.22 / 60)) < 1e-9, '緯度 ddmm→10進度変換');
assert(p.quality === 1 && p.numSV === 12 && p.hdop === 0.8 && p.alt === 93.5, 'GGAフィールド');

const gst = parseSentence(cs('GNGST,123456.00,2.5,,,,1.20,0.90,2.10'));
assert(gst.valid && gst.latStd === 1.2 && gst.lonStd === 0.9, 'GSTパース');

const vtg = parseSentence(cs('GNVTG,12.3,T,,M,0.05,N,0.09,K,A'));
assert(vtg.valid && vtg.speedKmh === 0.09 && vtg.course === 12.3, 'VTGパース');

// 精度推定
const accGst = estimateHorizontalAccuracy({ latStd: 3, lonStd: 4, hdop: 1 }, 5);
assert(accGst.value === 5 && accGst.source === 'GST', 'GST優先のDRMS');
const accDop = estimateHorizontalAccuracy({ latStd: null, lonStd: null, hdop: 1.2 }, 5);
assert(Math.abs(accDop.value - 6) < 1e-9 && accDop.source === 'HDOP×UERE', 'HDOP×UEREフォールバック');

// LineBuffer：チャンク分割の復元
const lb = new LineBuffer();
const out = [...lb.push('$GNGGA,1234'), ...lb.push('56.00,A*7F\n$GNR'), ...lb.push('MC,123456.00,A*68\n')];
assert(out.length === 2 && out[0].startsWith('$GNGGA') && out[1].startsWith('$GNRMC'), 'LineBuffer 断片結合');

// 静的測位の集計
const base = { lat: 34.8536, lon: 135.472, altMSL: 93, fixQuality: 1, hdop: 1, pdop: 1.5, vdop: 1.2, satsUsed: 10 };
const eps = [];
for (let i = 0; i < 100; i++) {
  eps.push({ ...base, lat: base.lat + (Math.random() - 0.5) * 2e-5, lon: base.lon + (Math.random() - 0.5) * 2e-5 });
}
const st = computeStaticStats(eps);
assert(st.count === 100, '集計: 点数');
assert(Math.abs(st.center.lat - base.lat) < 1e-5, '集計: 平均緯度');
assert(st.drms > 0 && st.cep50 > 0 && st.cep95 >= st.cep50, '集計: DRMS/CEP');
assert(st.offsets.length === 100, '集計: 散布図オフセット');
const { lonM } = metersPerDegree(35);
assert(Math.abs(lonM - 111320 * Math.cos((35 * Math.PI) / 180)) < 1e-6, 'm/度 換算');

console.log(failed ? `\n${failed} 件失敗` : '\n全チェック OK');
process.exit(failed ? 1 : 0);
