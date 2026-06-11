// Wake Lock 管理（仕様 3-7）。記録中の画面維持に使う。
// 画面復帰（visibilitychange）で自動再取得する。
// BLE はバックグラウンドで切れるため「記録は画面表示中のみ有効」。
export class WakeLockManager {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.lock = null;
    this.wanted = false; // acquire 済みで保持し続けたいか
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') {
        this._request(); // 画面復帰時に再取得
      }
    });
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async acquire() {
    this.wanted = true;
    await this._request();
  }

  async _request() {
    if (!WakeLockManager.isSupported()) {
      this.onChange(false, '非対応');
      return;
    }
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => {
        this.lock = null;
        this.onChange(false, this.wanted ? '解除（画面復帰で再取得）' : '解除');
      });
      this.onChange(true, '取得中');
    } catch (e) {
      this.lock = null;
      this.onChange(false, '取得失敗');
    }
  }

  async release() {
    this.wanted = false;
    if (this.lock) {
      try {
        await this.lock.release();
      } catch (_) {}
      this.lock = null;
    }
    this.onChange(false, '解除');
  }
}
