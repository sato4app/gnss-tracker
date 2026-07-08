# 受信品質統計（NMEA 取りこぼし確認）設計 202607

`prompt.md` の要求への回答となる機能設計。**1回の測定**で次の2点を確認できるようにする。

1. u-blox MAX-M10S からの NMEA を、Pico がもれなく受信しきれているか。
2. Pico からアプリが受信した NMEA を処理しきれているか。処理できなかった場合の対応はどうしているか。

## 1. 考え方

パイプライン `M10S --UART--> Pico --BLE(NUS)--> アプリ` の各段で「入った数」と「出た数」を数え、
区間差分を突き合わせれば、どの段で・どれだけ取りこぼしたかが分かる。

```
        M10S ──UART──▶ Pico ──BLE notify──▶ LineBuffer ──▶ parser ──▶ EpochAssembler
欠落モード:  ①UART溢れ/化け   ②BLE送信破棄        ③通知消失      ④CS NG      ⑤未対応文     ⑥エポック/GSV欠け
検出手段:    Pico側 ng/drop   Pico側 txng      Δtxok−Δ受信行数   csNg計数    unknown計数   時刻ギャップ/msgNum
```

Pico は「ダムパイプ（NMEA を解釈せず素通しする）」の設計方針を維持する。カウンタ収集に必要なのは
行分割（既存処理）とチェックサム検証（既存関数 `_nmea_checksum_ok`）だけで、文の中身は一切解釈しない。

## 2. Pico 側: `$PPICO` 統計文（micropython/main.py）

起動からの累計カウンタを保持し、**BLE 接続中のみ 5 秒ごと**に独自文として配信する。

```
$PPICO,<seq>,<rx>,<ng>,<drop>,<txok>,<txng>*hh
```

| フィールド | 意味 |
|---|---|
| `seq` | 統計文の通し番号（1〜）。アプリ側で `$PPICO` 自体の欠落を検出する |
| `rx` | UART から受信した行数（累計） |
| `ng` | うちチェックサム NG の行数。**M10S→Pico 間の UART 溢れ・化けの兆候** |
| `drop` | 行にならないまま受信バッファ（2048 バイト超）を破棄した回数 |
| `txok` | BLE へ送信完了した行数（`$PPICO` 自身を含む） |
| `txng` | リトライ（5ms×10回）しても notify できず破棄した行数 |

- カウンタは snapshot → 送信の順で処理するため、`txok` はその `$PPICO` 自身を含まない
  （次回の `$PPICO` には含まれる）。
- チェックサム NG の行も**そのまま転送する**（ダムパイプ維持）。破棄はアプリ側で行う。
- `send_line()` は `None`（未接続）/ `True`（全接続へ送信完了）/ `False`（破棄あり）を返す。

## 3. アプリ側: `js/stream-stats.js`（StreamStats）

`reset()`（接続開始・モック開始・手動リセット）起点の累計。1秒ごとに接続タブへ描画する。

| カウンタ | 供給元 | 意味 |
|---|---|---|
| `lines` | handleFrame | LineBuffer が復元した全行（`$PPICO` 含む） |
| `csNg` | nmea-parser | チェックサム不一致（**計数して破棄**） |
| `parsedOk` | nmea-parser | 内容まで解釈した行（GGA/RMC/GSA/GSV/VTG/GST） |
| `unknown` | nmea-parser | チェックサム正常だが未対応の種別（**計数のみで無視**） |
| `discardedChars` | LineBuffer `onDiscard` | 行にならないまま捨てた文字数（4096 字超で破棄） |
| `epochs` / `epochGaps` | EpochAssembler | 確定エポック数 / 時刻ギャップ（1.5 秒超）から推定した欠落エポック数 |
| `gsvMissing` | EpochAssembler | GSV グループ（talker×signalId）で届かなかった msgNum の数 |
| `pico.*` / `picoSeqGaps` | `$PPICO` | Pico 側カウンタの最新値 / `seq` 抜けの数 |
| `bleLossEst` | 突合 | **BLE 通知欠落の推定**: Δ`txok` −（アプリの受信行数の増分）。下記参照 |

### BLE 欠落の推定ロジック

最初の `$PPICO` 受信時点の `txok` とアプリ受信行数を基準点として対応付け、以降は

```
bleLossEst = (txok − txok基準) − (受信行数 − 受信行数基準)   ※負は 0 に丸め
```

- 化けて届いた行は「受信した行」として数えられる（csNg 行き）ため、これは**通知ごと消えた分**の推定。
- BLE の in-flight データ分だけ基準点に数行のずれが乗り得るので、±数行は誤差とみなす。
- `txok` または `seq` が後退したら Pico 再起動とみなし基準点を取り直す。

### 処理できなかった場合の対応（確認事項2への回答）

| 事象 | 対応 |
|---|---|
| チェックサム NG 行 | `csNg` に計数して破棄（エポックには `invalidCount` として痕跡が残る） |
| 未対応センテンス | `unknown` に計数のみ。エポックの `sentenceTypes` にも種別カウントが残る |
| 行にならないゴミ | LineBuffer が 4096 字超で破棄し、文字数を `discardedChars` に計上 |
| `$PPICO` | 統計にのみ反映し、エポック組み立てには回さない |
| 描画が追いつかない場合 | `requestAnimationFrame` で最新エポックのみ描画（データ処理自体は間引かない） |

なお BLE notify はブラウザ側イベントキューに積まれるため、アプリの処理が一時的に遅くても
データは失われない（失われるのは BLE リンク層で、それは `bleLossEst` に現れる）。

## 4. UI（接続タブ「受信品質」）

- 受信行数 / CS NG、未対応文 / 破棄文字、エポック / 欠落、GSV部分欠落、BLE欠落（推定）、
  Pico統計 `$PPICO`（seq と欠落数）、Pico UART受信 / NG、Pico破棄 バッファ/BLE。
- 「統計リセット」ボタンで区間をやり直せる。接続開始・モック開始でも自動リセット。
- **すべて 0（BLE欠落 0・Pico NG 0）なら「M10S→Pico→アプリまで取りこぼしなし」と確認できる。**

## 5. 測定記録への保存

静的測位1回分の区間差分（`diffRxStats(停止時, 開始時)`）を `session.summary.rxStats` に保存し、
記録結果パネル（`formatStats`）の末尾に表示する。区間開始時に `$PPICO` 未受信だった場合、
Pico カウンタ差分は帰属不明のため `pico: null`（表示は「Pico統計（$PPICO）なし」）とする。

## 6. 制約・注意

- 接続直後の初回エポックは途中受信のため GSV 部分欠落に 1 回分計上され得る（誤差として無視してよい）。
- モック配信（mock-feeder.js）も `$PPICO` を模擬する（欠落ゼロの整合値 → BLE欠落推定は 0 になるはず）。
- Pico のカウンタは起動からの累計で、切断・再接続ではリセットされない（アプリ側が差分を取る）。
- 検証: `node tools/check-syntax.mjs`（$PPICO パース・StreamStats 集計・GSV欠落・エポックギャップのテストを含む）。
