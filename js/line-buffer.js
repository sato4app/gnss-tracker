// BLE notify のチャンクと NMEA の1行は一致しない（ATT_MTU−3 ごとに分割されて届く）。
// チャンクを連結し、改行と NMEA のチェックサム(*XX)で行末を判定して1文ずつ取り出す。

const NMEA_END = /\*[0-9A-Fa-f]{2}$/; // 完結した NMEA 文の末尾（チェックサム）

export class LineBuffer {
  constructor() {
    this.buf = '';
  }

  // チャンク文字列を投入し、完成した行（空行除く）の配列を返す
  push(chunk) {
    this.buf += chunk;
    const out = [];

    // 改行があれば、その手前までを行として確定。末尾断片は持ち越す。
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop();
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }

    // 改行が無くても、*XX で終わっていれば完結した1文として確定。
    // （途中までの断片は *XX に一致しないので持ち越される）
    const rest = this.buf.trim();
    if (rest && NMEA_END.test(rest)) {
      out.push(rest);
      this.buf = '';
    }

    // 暴走防止：行にならないゴミが溜まり続けたら捨てる
    if (this.buf.length > 4096) this.buf = '';

    return out;
  }

  // 接続終了時などに残りを吐き出す
  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
