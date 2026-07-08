// スカイプロット：仰角（中心90°→外周0°）と方位角（北を上、時計回り）で衛星を配置。
// 使用中＝塗りつぶし、可視のみ＝中抜き。円の大きさ＝SNR。色＝コンステレーション。
// GSV が欠けた秒はブランクにせず前フレームを保持し、HOLD_MS 超過でクリアする（キャリーフォワード）。
import { CONSTELLATION_COLORS } from './nmea-parser.js';
import { CanvasView, HOLD_MS, holdDecision } from './canvas-view.js';

export class SkyPlotView extends CanvasView {
  _computeSize() {
    const s = Math.min(this.canvas.clientWidth || 320, this.canvas.clientHeight || 320);
    return { w: s, h: s };
  }

  // クリア＋グリッド（仰角リング 0/30/60° と方位の十字・NSEW ラベル）を描き、幾何を返す
  _drawGrid() {
    const ctx = this.ctx;
    const S = this.w;
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - 18;
    ctx.clearRect(0, 0, S, S);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (const el of [0, 30, 60]) {
      const r = R * (1 - el / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - R - 9);
    ctx.fillText('S', cx, cy + R + 9);
    ctx.fillText('E', cx + R + 9, cy);
    ctx.fillText('W', cx - R - 9, cy);

    return { cx, cy, R };
  }

  update(epoch) {
    const now = epoch?.recvAt ?? Date.now();
    const hasSats = (epoch?.satellites || []).some((s) => s.elev != null && s.azim != null);
    const age = this._lastSatAt == null ? Infinity : now - this._lastSatAt;

    const decision = holdDecision(hasSats, age, HOLD_MS);
    if (decision === 'hold') return; // 前フレーム保持（クリアも描画もしない）
    if (decision === 'clear') {
      // 失効：ゴースト衛星を残さないようクリア（グリッドのみ再描画）
      this._last = null;
      this._lastSatAt = null;
      this._syncSize();
      this._drawGrid();
      return;
    }

    this._last = epoch; // 最後の有効エポック（リサイズ再描画用）
    this._lastSatAt = now;
    this._syncSize();
    const ctx = this.ctx;
    const { cx, cy, R } = this._drawGrid();

    for (const sat of epoch.satellites || []) {
      if (sat.elev == null || sat.azim == null) continue;
      const el = Math.max(0, Math.min(90, sat.elev));
      const r = R * (1 - el / 90);
      const a = (sat.azim * Math.PI) / 180; // 0=北(上), 時計回り
      const x = cx + r * Math.sin(a);
      const y = cy - r * Math.cos(a);
      const color = CONSTELLATION_COLORS[sat.sys] || CONSTELLATION_COLORS.unknown;
      const rad = sat.snr != null ? 4 + Math.min(sat.snr, 50) / 10 : 4;

      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      if (sat.used) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(String(sat.prn), x, y + rad + 7);
    }
  }
}
