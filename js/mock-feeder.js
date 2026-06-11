// 開発用：Pico がなくても動作確認できる合成NMEA生成器。
// チェックサムは計算して付与するのでパーサで検証が通る。
// 1Hzで GNRMC/GNGGA/GNGSA(×2)/GxGSV/GNVTG/GNGST を流す。たまにフレームを
// 途中で割って LineBuffer の断片結合も試せるようにしている。
// 実 BLE(NmeaBle) と同じ onFrame I/F で差し替え可能。

function nmeaLine(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return `$${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}`;
}

// 10進度 → ddmm.mmmm
function ddmm(deg) {
  const d = Math.floor(Math.abs(deg));
  const m = (Math.abs(deg) - d) * 60;
  return `${d}${m.toFixed(4).padStart(7, '0')}`;
}

// GSAを12スロット固定で安全に組み立てる
function gsa(usedPrns, pdop, hdop, vdop, sysId) {
  const slots = usedPrns.map(String);
  while (slots.length < 12) slots.push('');
  return nmeaLine(`GNGSA,A,3,${slots.join(',')},${pdop},${hdop},${vdop},${sysId}`);
}

function gsvLines(talker, sats) {
  // sats: [prn, elev, azim]、SNRは仰角からおおまかに生成
  const perMsg = 4;
  const total = Math.ceil(sats.length / perMsg);
  const out = [];
  for (let m = 0; m < total; m++) {
    const chunk = sats.slice(m * perMsg, m * perMsg + perMsg);
    let body = `${talker}GSV,${total},${m + 1},${sats.length}`;
    for (const [prn, el, az] of chunk) {
      const snr = el > 40 ? 38 + Math.floor(Math.random() * 12) : 18 + Math.floor(Math.random() * 16);
      body += `,${prn},${el},${az},${snr}`;
    }
    body += ',1';
    out.push(nmeaLine(body));
  }
  return out;
}

export class MockFeeder {
  constructor(onFrame, { hz = 1, withGst = true } = {}) {
    this.onFrame = onFrame;
    this.intervalMs = 1000 / hz;
    this.withGst = withGst; // GST あり/なし両方の精度推定経路を試せる
    this.timer = null;
    // 箕面大滝付近の基準座標
    this.lat = 34.853667;
    this.lon = 135.472041;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const time = `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}.00`;
    const date = `${p2(now.getUTCDate())}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCFullYear() % 100)}`;

    const jitter = () => (Math.random() - 0.5) * 0.00003;
    const lat = this.lat + jitter();
    const lon = this.lon + jitter();
    const la = ddmm(lat);
    const lo = ddmm(lon);
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';

    const numSV = 9 + Math.floor(Math.random() * 5);
    const hdop = (0.7 + Math.random() * 0.7).toFixed(1);
    const pdop = (1.0 + Math.random() * 0.9).toFixed(1);
    const vdop = (0.9 + Math.random() * 0.8).toFixed(1);
    const alt = (92 + Math.random() * 3).toFixed(1);

    const lines = [];
    lines.push(nmeaLine(`GNRMC,${time},A,${la},${ns},${lo},${ew},0.05,,${date},,,A`));
    lines.push(nmeaLine(`GNGGA,${time},${la},${ns},${lo},${ew},1,${numSV},${hdop},${alt},M,38.0,M,,`));
    lines.push(nmeaLine(`GNVTG,,T,,M,0.05,N,0.09,K,A`));
    if (this.withGst) {
      const sd = () => (0.8 + Math.random() * 1.5).toFixed(2);
      lines.push(nmeaLine(`GNGST,${time},2.5,,,,${sd()},${sd()},${sd()}`));
    }
    lines.push(gsa([1, 8, 11, 17, 19, 22, 28], pdop, hdop, vdop, 1)); // GPS
    lines.push(gsa([65, 72, 81], pdop, hdop, vdop, 2)); // GLONASS
    lines.push(...gsvLines('GP', [[1, 55, 120], [8, 40, 200], [11, 30, 75], [17, 65, 310], [19, 22, 45], [22, 48, 160], [28, 15, 280]]));
    lines.push(...gsvLines('GQ', [[193, 70, 150], [194, 60, 210]])); // QZSS（みちびき）
    lines.push(...gsvLines('GL', [[65, 35, 90], [72, 50, 330], [81, 20, 15]]));

    const text = lines.join('\r\n') + '\r\n';

    // 30%の確率で1フレームを途中で割って送る（行バッファのテスト）
    if (Math.random() < 0.3) {
      const cut = Math.floor(text.length * (0.3 + Math.random() * 0.4));
      this.onFrame(text.slice(0, cut));
      setTimeout(() => this.onFrame(text.slice(cut)), 40);
    } else {
      this.onFrame(text);
    }
  }
}
