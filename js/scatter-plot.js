// 静的測位の散布図：中心からの東西(E)×南北(N)オフセット [m] を描画。
// CEP50 / DRMS の円も重ねて表示する。
import { CanvasView } from './canvas-view.js';

export class ScatterPlotView extends CanvasView {
  _computeSize() {
    const s = Math.min(this.canvas.clientWidth || 280, 360);
    return { w: s, h: s };
  }

  clear() {
    this._last = null;
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  // stats: computeStaticStats の戻り値（offsets / cep50 / drms を使用）
  update(stats) {
    this._last = stats;
    this._syncSize();
    const ctx = this.ctx;
    const S = this.w;
    const cx = S / 2;
    const cy = S / 2;
    ctx.clearRect(0, 0, S, S);
    if (!stats || !stats.offsets?.length) return;

    // スケール：最大半径か CEP95 の大きい方が収まるように（最低 1 m）
    const maxR = Math.max(
      1,
      stats.cep95 || 0,
      ...stats.offsets.map((o) => Math.sqrt(o.e ** 2 + o.n ** 2))
    );
    const R = S / 2 - 24;
    const scale = R / maxR;

    // グリッド十字＋目盛りリング
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 8);
    ctx.lineTo(cx, S - 8);
    ctx.moveTo(8, cy);
    ctx.lineTo(S - 8, cy);
    ctx.stroke();

    // 目盛りリング（キリのいい間隔で2本）
    const step = niceStep(maxR);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let r = step; r <= maxR + step / 2; r += step) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${fmtM(r)}`, cx + r * scale * 0.7071 + 2, cy - r * scale * 0.7071 - 2);
    }

    // CEP50（緑）と DRMS（青）の円
    drawStatCircle(ctx, cx, cy, stats.cep50, scale, '#36c98d', 'CEP50');
    drawStatCircle(ctx, cx, cy, stats.drms, scale, '#4f9dff', 'DRMS');

    // 各点
    ctx.fillStyle = 'rgba(240,169,58,0.75)';
    for (const o of stats.offsets) {
      ctx.beginPath();
      ctx.arc(cx + o.e * scale, cy - o.n * scale, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 中心
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // 軸ラベル
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, 14);
    ctx.fillText('S', cx, S - 14);
    ctx.fillText('E', S - 14, cy);
    ctx.fillText('W', 14, cy);
  }
}

function drawStatCircle(ctx, cx, cy, r, scale, color, label) {
  if (r == null || !(r > 0)) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, cx + r * scale * 0.7071 + 2, cy + r * scale * 0.7071 + 2);
}

// 目盛り間隔を 1/2/5×10^n に丸める
function niceStep(maxR) {
  const raw = maxR / 2;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * pow;
}

function fmtM(v) {
  return v >= 10 ? `${Math.round(v)}m` : `${v.toFixed(1)}m`;
}
