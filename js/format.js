// 表示用フォーマッタ（DOM に触れない純粋関数）。数値整形・エスケープ・
// 測位バッジ・記録テキストなど「値 → 表示文字列」変換を一箇所に集約する。

// 数値を「—」フォールバック付きで整形（null/undefined は — に）
export const fmt = (v, digits = 1, unit = '') => (v == null ? '—' : v.toFixed(digits) + unit);

// HTML 特殊文字のエスケープ（セッションラベル等の innerHTML 埋め込み用）
export function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GSA fixMode（1=測位なし / 2=2D / 3=3D）→ 表示ラベル
export const FIX_MODE = { 1: 'No fix', 2: '2D', 3: '3D' };

// GGA quality（fixQuality）→ バッジ表示
const FIX_BADGE = {
  0: { t: 'No fix', cls: 'bad' },
  1: { t: 'GPS', cls: 'ok' },
  2: { t: 'DGPS', cls: 'ok' },
  4: { t: 'RTK Fixed', cls: 'good' },
  5: { t: 'RTK Float', cls: 'warn' },
  6: { t: '推測航法', cls: 'warn' },
};

// 測位状態バッジ {t, cls} を決める。GGA quality と GSA fixMode を組み合わせる。
export function fixBadge(epoch) {
  if (epoch.fixQuality == null || epoch.fixQuality === 0) return { t: 'No fix', cls: 'bad' };
  if (epoch.fixQuality === 1 && epoch.fixMode === 2) return { t: '2D', cls: 'warn' };
  if (epoch.fixQuality === 1 && epoch.fixMode === 3) return { t: '3D', cls: 'ok' };
  return FIX_BADGE[epoch.fixQuality] || { t: `fix${epoch.fixQuality}`, cls: 'ok' };
}

// 静的測位セッションの集計テキスト（記録結果パネル表示用）
export function formatStats(session, st) {
  const fixLine = Object.entries(st.fixCounts).map(([q, n]) => `fix${q}:${n}`).join(' ');
  return [
    `【${session.label}】 収集 ${st.count} エポック`,
    `中心: ${st.center.lat.toFixed(7)}, ${st.center.lon.toFixed(7)}（中央値: ${st.median.lat.toFixed(7)}, ${st.median.lon.toFixed(7)}）`,
    `標準偏差: 東西 ${st.stdEastM.toFixed(2)} m / 南北 ${st.stdNorthM.toFixed(2)} m`,
    `DRMS ${st.drms.toFixed(2)} m / 2DRMS ${st.drms2.toFixed(2)} m`,
    `CEP50 ${st.cep50?.toFixed(2)} m / CEP95 ${st.cep95?.toFixed(2)} m`,
    `標高: 平均 ${st.altMean != null ? st.altMean.toFixed(1) : '—'} m ± ${st.altStd != null ? st.altStd.toFixed(1) : '—'} m`,
    `fix内訳: ${fixLine}　平均HDOP ${st.avgHdop != null ? st.avgHdop.toFixed(1) : '—'}　平均衛星数 ${st.avgSats != null ? st.avgSats.toFixed(1) : '—'}`,
  ].join('\n');
}

// 記録一覧の副見出しテキスト（種別により内容が変わる）
export function sessionSubText(session) {
  const when = new Date(session.createdAt).toLocaleString('ja-JP');
  const s = session.summary;
  if (session.type === 'static') {
    return `${when}　${s?.count ?? 0}点` + (s?.drms != null ? `　DRMS ${s.drms.toFixed(2)}m` : '');
  }
  return when + (s?.lat != null ? `　(${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})` : '');
}
