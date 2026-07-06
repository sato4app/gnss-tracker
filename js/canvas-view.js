// Canvas 系ビュー（スカイプロット / SNR / 散布図）の共通土台。
// ctx 取得・devicePixelRatio 対応のリサイズ・リサイズ時の自動再描画をまとめる。
// サブクラスは _computeSize() で論理サイズ [CSS px] を返し、update() を実装する。
export class CanvasView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._last = null; // 直近の描画データ（リサイズ時の再描画用）
    this.w = 0;
    this.h = 0;
    this._resize();
    window.addEventListener('resize', () => {
      this._resize();
      if (this._last != null) this.update(this._last);
    });
  }

  // 論理サイズ {w, h}[CSS px]。既定は要素の client サイズ。正方形ビュー等はオーバーライドする。
  _computeSize() {
    return { w: this.canvas.clientWidth || 0, h: this.canvas.clientHeight || 0 };
  }

  // 実解像度を DPR に合わせ、以後は CSS px 座標系で描ける状態にする
  _resize() {
    const { w, h } = this._computeSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  // オーバーレイ表示直後などにサイズが変わっていれば再適用する（描画前に呼ぶ）
  _syncSize() {
    if (!this.canvas.clientWidth) return;
    const { w, h } = this._computeSize();
    if (w !== this.w || h !== this.h) this._resize();
  }

  update() {}
}
