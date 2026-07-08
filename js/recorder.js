// 特定地点の GNSS 値の記録（仕様 3-6）。
//   (A) スナップショット記録: 現在エポックの1点を保存
//   (B) 静的測位記録: 一点に留まり N秒 or Mエポック を連続収集 → 集計して保存
//       autoStop 有効時は「最低 minSec 秒 → 中心・DRMS が holdSec 秒横ばい」で自動停止
//       （docs/static-autostop-202607.md）。maxSec/maxEpochs はタイムアウト（保険）として併用。
// 保存先は IndexedDB（storage.js）。集計は accuracy.js の computeStaticStats。
// 静的測位は測定区間の受信品質（rxStats）も summary に残す（docs/rx-integrity-202607.md）。
import { computeStaticStats, evaluateConvergence } from './accuracy.js';
import { diffRxStats } from './stream-stats.js';

// 収束自動停止の判定パラメータ（設定画面には出さないモジュール定数）
const CONVERGENCE = { holdSec: 10, centerTolM: 0.3, drmsTolAbsM: 0.3, drmsTolPct: 0.05 };

// 品質ゲート：そのエポックを収束判定に使えるか（停止用途のみ。記録の蓄積条件は変えない）
function qualityOk(epoch) {
  return epoch.fixMode === 3 && epoch.hdop != null && epoch.hdop <= 3 && epoch.satsUsed != null && epoch.satsUsed >= 5;
}

// エポックから保存用のサンプル（必要最小限のフィールド）を取り出す
function toSample(epoch) {
  return {
    t: epoch.t ? epoch.t.getTime() : epoch.recvAt,
    lat: epoch.lat,
    lon: epoch.lon,
    altMSL: epoch.altMSL,
    fixQuality: epoch.fixQuality,
    fixMode: epoch.fixMode,
    satsUsed: epoch.satsUsed,
    satsInView: epoch.satsInView,
    pdop: epoch.pdop,
    hdop: epoch.hdop,
    vdop: epoch.vdop,
    latStd: epoch.latStd,
    lonStd: epoch.lonStd,
    speedKmh: epoch.speedKmh,
    course: epoch.course,
  };
}

export class Recorder {
  constructor(storage, { onStaticUpdate, onStaticStop, getRxStats } = {}) {
    this.storage = storage;
    this.onStaticUpdate = onStaticUpdate || (() => {}); // 収集中のライブ表示更新
    this.onStaticStop = onStaticStop || (() => {}); // 自動停止を含む停止通知
    this.getRxStats = getRxStats || null; // 受信品質統計の snapshot 提供元（app.js）
    this.latestEpoch = null;
    this.static = null; // 収集中: { label, memo, startedAt, samples, maxSec, maxEpochs, paused }
  }

  // 毎エポック呼ぶ。静的測位収集中なら fix のあるエポックを蓄積する。
  addEpoch(epoch) {
    this.latestEpoch = epoch;
    const st = this.static;
    if (!st || st.paused) return;
    if (epoch.lat == null || epoch.lon == null || !(epoch.fixQuality > 0)) return;

    st.samples.push(toSample(epoch));
    const elapsedSec = (Date.now() - st.startedAt) / 1000;
    const stats = computeStaticStats(st.samples); // 暫定ばらつき（点数は高々数百なので毎回計算で十分軽い）

    // 収束状況の算出（品質ゲート通過エポックのみ履歴に積む。不良で連続性リセット）
    let convergence = null;
    if (st.autoStop) {
      if (qualityOk(epoch) && stats) {
        st.convHistory.push({ t: elapsedSec, lat: stats.center.lat, lon: stats.center.lon, drms: stats.drms });
        // 古い履歴の間引き（基準点確保のため holdSec より 5 秒余裕を残す）
        const keepFrom = elapsedSec - CONVERGENCE.holdSec - 5;
        if (st.convHistory[0].t < keepFrom) st.convHistory = st.convHistory.filter((h) => h.t >= keepFrom);
        convergence = evaluateConvergence(st.convHistory, elapsedSec, { minSec: st.minSec, ...CONVERGENCE });
      } else {
        st.convHistory = []; // 品質不良 →「安定して10秒」の連続カウントをやり直す
      }
    }

    this.onStaticUpdate({ count: st.samples.length, elapsedSec, stats, convergence });

    // 収束停止（最低時間経過＋直近 holdSec 窓で中心・DRMS 横ばい）
    if (convergence && convergence.stable) {
      this.stopStatic('converged');
      return;
    }

    // タイムアウト停止（既存動作。0 は無効）
    if (st.maxSec > 0 && elapsedSec >= st.maxSec) {
      this.stopStatic('timeout');
    } else if (st.maxEpochs > 0 && st.samples.length >= st.maxEpochs) {
      this.stopStatic('maxEpochs');
    }
  }

  get isStaticRunning() {
    return !!this.static;
  }

  // 画面非表示中は収集を一時停止する（BLE も切れるため。仕様 3-7）
  setPaused(paused) {
    if (this.static) this.static.paused = paused;
  }

  // ---- (A) スナップショット記録 ----
  async saveSnapshot({ label = '', memo = '' } = {}) {
    const epoch = this.latestEpoch;
    if (!epoch || epoch.lat == null || epoch.lon == null) {
      throw new Error('有効な測位データがありません');
    }
    const id = `snap_${Date.now()}`;
    const sample = toSample(epoch);
    const session = {
      id,
      type: 'snapshot',
      label: label || `地点 ${new Date().toLocaleString('ja-JP')}`,
      memo,
      createdAt: Date.now(),
      summary: {
        lat: sample.lat,
        lon: sample.lon,
        altMSL: sample.altMSL,
        fixQuality: sample.fixQuality,
        hdop: sample.hdop,
        satsUsed: sample.satsUsed,
      },
    };
    await this.storage.putSession(session);
    await this.storage.putPoint({ id: `${id}_p`, sessionId: id, kind: 'snapshot', sample });
    return session;
  }

  // ---- (B) 静的測位記録 ----
  startStatic({ label = '', memo = '', maxSec = 60, maxEpochs = 120, autoStop = true, minSec = 30 } = {}) {
    if (this.static) return;
    this.static = {
      label: label || `静的測位 ${new Date().toLocaleString('ja-JP')}`,
      memo,
      startedAt: Date.now(),
      samples: [],
      maxSec,
      maxEpochs,
      paused: false,
      autoStop, // 収束自動停止の有効/無効
      minSec, // 最低収集時間 [秒]（これ未満では絶対に停止しない）
      convHistory: [], // [{ t, lat, lon, drms }] 品質ゲート通過エポックのみ
      rxStart: this.getRxStats ? this.getRxStats() : null, // 受信品質の測定開始時点
    };
    this.onStaticUpdate({ count: 0, elapsedSec: 0, stats: null, convergence: null });
  }

  async stopStatic(reason = 'manual') {
    const st = this.static;
    if (!st) return null;
    this.static = null;

    const stats = computeStaticStats(st.samples);
    // この測定区間の受信品質（開始時点との差分）。取りこぼし確認用。
    const rxStats = this.getRxStats ? diffRxStats(this.getRxStats(), st.rxStart) : null;
    const id = `static_${Date.now()}`;
    const session = {
      id,
      type: 'static',
      label: st.label,
      memo: st.memo,
      createdAt: st.startedAt,
      endedAt: Date.now(),
      summary: stats
        ? {
            lat: stats.center.lat,
            lon: stats.center.lon,
            altMSL: stats.altMean,
            count: stats.count,
            drms: stats.drms,
            cep50: stats.cep50,
            cep95: stats.cep95,
            stopReason: reason, // 'converged' | 'timeout' | 'maxEpochs' | 'manual'
            rxStats,
          }
        : { count: 0, stopReason: reason, rxStats },
    };
    await this.storage.putSession(session);
    await this.storage.putPoint({
      id: `${id}_p`,
      sessionId: id,
      kind: 'static',
      stats, // 集計値（中心・標準偏差・DRMS・CEP・散布図オフセット等）
      samples: st.samples, // 生エポック群
    });
    this.onStaticStop(session);
    return session;
  }
}
