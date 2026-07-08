# 衛星表示の保持（キャリーフォワード）実装仕様（実装プロンプト・202607）

> このファイルは実装指示（プロンプト）です。以下の**確定仕様**に従い、スカイプロットと
> SNRチャートが「衛星データの無い秒にブランク（点滅）する」問題を、**前フレームを保持し、
> 新しい衛星データが揃ったときだけ描き替える**方式（キャリーフォワード）で解消してください。
> **測位・パース・エポック組み立て・地図・記録のロジックは変更しないこと。**

## 0. 背景・症状

- 測定開始後、スカイプロット等が表示されるが約1秒で消え、数秒待つと再表示される（点滅する）。
- 位置・DOP など数値表は毎秒更新され続け、**衛星系の描画（スカイプロット／SNRチャート）だけ**が点滅する。

## 1. 原因（要約）

- 描画は「1エポック確定ごと」（[js/app.js](../js/app.js) `onEpoch` → `render`）。
- スカイプロット／SNRチャートはそのエポックの `epoch.satellites`（GSV 由来）だけを使う。
- マルチGNSSでは GSV が毎秒完全には揃わない（BLE欠落・チェックサム不正で一部破棄、受信機のGSVレート）。
  → GSV が欠けた秒のエポックは `satellites` が空。
- [js/sky-plot.js](../js/sky-plot.js) / [js/snr-chart.js](../js/snr-chart.js) の `update()` は**毎回 `clearRect()` してから描く**ため、
  衛星ゼロの秒に「消してから描くものが無い」＝**ブランク**になる。
- なお [js/app.js](../js/app.js) の系統別チップは `if (sysIds.size)` で**空なら上書きしない＝前表示を保持**しており、
  既にキャリーフォワード挙動。**canvas 2種をこれに揃える**のが本対応。

## 2. 方針（確定仕様）

スカイプロット／SNRチャートの `update(epoch)` を次の3分岐にする。

1. **衛星データあり**（`epoch.satellites` に1件以上）
   → その衛星データを「最後の有効データ」として保持し、**通常どおり全描画**する。
2. **衛星データなし かつ 失効時間内**（最後の有効データから `HOLD_MS` 以内）
   → **何もしない（再描画しない）**。直前フレームがそのまま残る＝表示を保持。
3. **衛星データなし かつ 失効時間超過**（`HOLD_MS` 超）
   → 古い衛星を残し続けないよう**クリア**する（グリッド／軸のみ再描画してよい）。

- 「衛星データあり」の判定は、
  - スカイプロット：`(epoch.satellites || []).some(s => s.elev != null && s.azim != null)`
  - SNRチャート：`(epoch.satellites || []).some(s => s.snr != null)`
  （各ビューが実際に描くのに必要なデータの有無で判定する）
- リサイズ時（[js/canvas-view.js](../js/canvas-view.js) の resize リスナ）は、保持中の**最後の有効エポック**で
  再描画されるようにする（`this._last` に最後の有効エポックを入れておけば既存の仕組みで動く）。
- **対象は sky-plot と snr-chart のみ。** scatter-plot（静的測位の散布図）は live 衛星ではなく集計値
  （`stats`）駆動なので**変更しない**。

## 3. パラメータ

| 名前 | 既定値 | 種別 | 説明 |
|---|---|---|---|
| `HOLD_MS` | `8000`（8秒） | 定数 | 衛星データが来ない間、直前表示を保持する上限。超過でクリア |

- `HOLD_MS` は各ビュー共通の定数として1箇所に定義（例：[js/canvas-view.js](../js/canvas-view.js) から export、
  または両ビューで同値のローカル定数）。設定画面には出さない。
- 時刻は `epoch.recvAt`（無ければ `Date.now()`）を使う。

## 4. 実装箇所

- [js/sky-plot.js](../js/sky-plot.js)：`update()` を3分岐化。保持用フィールド `_lastSatAt` を追加。
  描画は保持中の衛星集合（＝最後に有効だった `epoch.satellites`）を使う。
- [js/snr-chart.js](../js/snr-chart.js)：同上。
- [js/canvas-view.js](../js/canvas-view.js)：
  - 純粋関数 `holdDecision(hasSats, ageMs, holdMs)` を追加（テスト用）。
  - 併せて `HOLD_MS` 定数をここに置き、両ビューで import してもよい。
- [tools/check-syntax.mjs](../tools/check-syntax.mjs)：`holdDecision` の単体テストを追加。
- ドキュメント：[docs/design-202606.md](design-202606.md) の sky-plot/snr-chart 行に
  「衛星データ欠落時は前フレーム保持（HOLD_MS 失効）」を追記。

## 5. 更新ロジック（疑似コード）

純粋関数（[js/canvas-view.js](../js/canvas-view.js)）:

```js
// hasSats: 今回のエポックに描画可能な衛星データがあるか
// ageMs:   最後に有効データを受けてからの経過ms
// 返り値: 'draw'（全描画）| 'hold'（前フレーム保持・何もしない）| 'clear'（クリア）
export function holdDecision(hasSats, ageMs, holdMs) {
  if (hasSats) return 'draw';
  return ageMs <= holdMs ? 'hold' : 'clear';
}
```

各ビューの `update(epoch)`（スカイプロット例。SNRも同型で `snr != null` 判定）:

```
update(epoch):
  now = epoch?.recvAt ?? Date.now()
  hasSats = (epoch?.satellites || []).some(s => s.elev != null && s.azim != null)
  age = this._lastSatAt == null ? Infinity : now - this._lastSatAt

  switch holdDecision(hasSats, age, HOLD_MS):
    case 'hold':
      return                               // 前フレーム保持（クリアも描画もしない）
    case 'clear':
      this._last = null; this._lastSatAt = null
      this._syncSize(); ctx.clearRect(...)
      drawGridOnly()                       // 任意：グリッド/軸のみ
      return
    case 'draw':
      this._last = epoch                   // 最後の有効エポック（リサイズ再描画用）
      this._lastSatAt = now
      // …以降は現状のクリア＋グリッド＋衛星描画（epoch.satellites を使用）…
```

- `'draw'` 分岐は**現状の `update()` 本体をほぼそのまま**流用する（先頭の `this._last = epoch;` を上の形に置換）。
- `'hold'` は早期 return するだけ。`this._syncSize()` も呼ばない（サイズ変化はリサイズリスナが処理）。
- base クラスの resize リスナは `if (this._last != null) this.update(this._last)` なので、
  保持中（最後の有効エポックが `_last`）はリサイズ時に正しく再描画される。

## 6. 任意の追加（スコープ外・推奨度低）

- **系統別チップの失効揃え**：現状の `if (sysIds.size)` は無期限に保持する。厳密に揃えるなら
  同じ `HOLD_MS` 失効を [js/app.js](../js/app.js) 側にも入れてよい（必須ではない）。
- **`lv-sats`（使用/視野内）**：GSV欠落時に視野内が `—` になる場合、直近値を保持してもよい（任意）。
- **根本対処（受信機側）**：GSV が毎秒出ているか [micropython/main.py](../micropython/main.py) の
  UBX-CFG-MSG で確認・1Hz化。ただしBLE欠落は残るため、本対応（保持）と**併用**が前提。

## 7. 注意事項

- **測位パイプラインは不変**：本対応は表示層（2ビュー）だけ。`epoch` 構造・記録データは変更しない。
- **失効は必須**：`HOLD_MS` を入れないと、信号ロス後に古い衛星が残り続ける。必ず入れる。
- **判定はビューごとに“描くのに必要なデータ”で**：スカイは elev/azim、SNRは snr。
  片方だけ来た秒でも、それぞれのビューが適切に保持/描画できる。
- **scatter-plot は対象外**（集計値駆動のため）。

## 8. 受け入れ基準

1. GSV が毎秒揃わない実機環境で、スカイプロット／SNRチャートが**点滅しない**（前フレームが保持される）。
2. 衛星データが来た秒には、その内容で**即座に描き替わる**。
3. 信号を完全に失って `HOLD_MS`（8秒）を超えると、両ビューが**クリア**される（ゴースト衛星が残らない）。
4. 解析タブを開き直す／画面回転（リサイズ）しても、保持中の最後の有効データで正しく再描画される。
5. 位置・DOP など数値表と散布図の挙動は**従来どおり**（変化なし）。
6. `node tools/check-syntax.mjs` が全 OK（下記テスト込み）。

## 9. テスト（[tools/check-syntax.mjs](../tools/check-syntax.mjs) に追加）

`holdDecision` の純粋関数を検証する：

- `holdDecision(true, 0, 8000) === 'draw'`（衛星ありは常に描画）
- `holdDecision(false, 3000, 8000) === 'hold'`（失効時間内は保持）
- `holdDecision(false, 8001, 8000) === 'clear'`（失効超過はクリア）
- `holdDecision(false, Infinity, 8000) === 'clear'`（一度も受信していない＝初期状態はクリア）

---

### 実装順序（推奨）
1. [js/canvas-view.js](../js/canvas-view.js)：`holdDecision` ＋ `HOLD_MS` 追加、テスト追加。
2. [js/sky-plot.js](../js/sky-plot.js)：`update()` を3分岐化。
3. [js/snr-chart.js](../js/snr-chart.js)：同様に3分岐化。
4. `node tools/check-syntax.mjs` で検証、実機／モックで点滅解消を確認。
