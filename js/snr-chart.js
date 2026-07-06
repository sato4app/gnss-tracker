// SNR（C/N0）棒グラフ：可視衛星ごとに1本。色＝コンステレーション、
// 使用中＝濃い、可視のみ＝薄い。コンステ順→PRN順に並べる。
import { CONSTELLATION_COLORS } from './nmea-parser.js';
import { CanvasView } from './canvas-view.js';

const ORDER = ['gps', 'glonass', 'galileo', 'beidou', 'qzss', 'mixed', 'unknown'];

export class SnrChartView extends CanvasView {
  _computeSize() {
    return { w: this.canvas.clientWidth || 600, h: this.canvas.clientHeight || 200 };
  }

  update(epoch) {
    this._last = epoch;
    this._syncSize();
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    const padT = 14;
    const padB = 22;
    const padL = 26;
    const maxSnr = 55;
    const plotH = H - padT - padB;

    // 目盛り（0/20/40 dBHz）
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0, 20, 40]) {
      const y = padT + plotH * (1 - v / maxSnr);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillText(String(v), padL - 4, y);
    }

    const sats = (epoch.satellites || [])
      .filter((s) => s.snr != null)
      .sort((a, b) => ORDER.indexOf(a.sys) - ORDER.indexOf(b.sys) || a.prn - b.prn);
    if (!sats.length) return;

    const gap = 3;
    const bw = Math.max(4, (W - padL - 6 - gap * (sats.length - 1)) / sats.length);
    ctx.textAlign = 'center';
    sats.forEach((s, i) => {
      const x = padL + 4 + i * (bw + gap);
      const bh = (plotH * Math.min(s.snr, maxSnr)) / maxSnr;
      const y = padT + plotH - bh;
      const color = CONSTELLATION_COLORS[s.sys] || CONSTELLATION_COLORS.unknown;
      ctx.globalAlpha = s.used ? 1 : 0.4;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, bw, bh);
      ctx.globalAlpha = 1;
      if (bw >= 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(s.prn), x + bw / 2, H - padB + 11);
      }
    });
  }
}
