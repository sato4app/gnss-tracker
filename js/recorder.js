// 特定地点の GNSS 値の記録（仕様 3-6）。
//   (A) スナップショット記録: 現在エポックの1点を保存
//   (B) 静的測位記録: 一点に留まり N秒 or Mエポック を連続収集 → 集計して保存
// 保存先は IndexedDB（storage.js）。集計は accuracy.js の computeStaticStats。
import { computeStaticStats } from './accuracy.js';

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
  constructor(storage, { onStaticUpdate, onStaticStop } = {}) {
    this.storage = storage;
    this.onStaticUpdate = onStaticUpdate || (() => {}); // 収集中のライブ表示更新
    this.onStaticStop = onStaticStop || (() => {}); // 自動停止を含む停止通知
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
    this.onStaticUpdate({ count: st.samples.length, elapsedSec, stats });

    // 自動停止条件（0 は無効）
    if ((st.maxSec > 0 && elapsedSec >= st.maxSec) || (st.maxEpochs > 0 && st.samples.length >= st.maxEpochs)) {
      this.stopStatic();
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
  startStatic({ label = '', memo = '', maxSec = 60, maxEpochs = 120 } = {}) {
    if (this.static) return;
    this.static = {
      label: label || `静的測位 ${new Date().toLocaleString('ja-JP')}`,
      memo,
      startedAt: Date.now(),
      samples: [],
      maxSec,
      maxEpochs,
      paused: false,
    };
    this.onStaticUpdate({ count: 0, elapsedSec: 0, stats: null });
  }

  async stopStatic() {
    const st = this.static;
    if (!st) return null;
    this.static = null;

    const stats = computeStaticStats(st.samples);
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
          }
        : { count: 0 },
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
