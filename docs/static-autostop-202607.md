# 静的測位「収束による自動停止」実装仕様（実装プロンプト・202607）

> このファイルは実装指示（プロンプト）です。以下の**確定仕様と既定値**のとおり、
> GNSS-Tracker の静的測位に「最低収集時間を過ぎ、座標・DRMS が一定時間横ばいに
> なったら自動停止する」機能を追加してください。**機能追加のみで既存の測位・
> パース・地図描画のロジックは変更しないこと。**

## 0. 背景・方針

- 現状の静的測位（`js/recorder.js`）は `maxSec` / `maxEpochs` 到達でのみ自動停止する。
- これを「**最低30秒 → 中心座標と DRMS が10秒間横ばいになったら自動停止**」に拡張する。
  上限時間（`maxSec`）は**タイムアウト（保険）**として残す。
- 重要な前提：MAX-M10S は単周波・自律測位のため、**「収束」＝「これ以上データを
  足しても推定が動かない（頭打ち）」**であって、**精度の保証ではない**。
  マルチパスで“安定して偏った”値に張り付くことがあるため、
  **品質ゲート（fix/HDOP/衛星数）と上限時間を必ず併用する。**
- DRMS・中心は累積統計なので時間とともに必ず平坦化する。したがって収束判定は
  「**直近 `holdSec` 秒の窓**での変動」で見る（累積値の単純な差分では早期停止するため不可）。

## 1. 停止条件（確定仕様）

静的測位収集中、毎エポック（1Hz）で以下を評価する。

**次のいずれかで停止する：**

1. **収束停止**（`staticAutoStop` が ON のとき）
   次を**すべて**満たす：
   - 経過時間 `elapsedSec >= minSec`（既定 30 秒）
   - 直近 `holdSec` 秒（既定 10 秒）が**連続して品質ゲートを満たしている**
   - 直近 `holdSec` 秒の**中心移動量 ≤ `centerTolM`**（既定 0.3 m）
   - 直近 `holdSec` 秒の **DRMS 変動幅 ≤ max(`drmsTolAbsM`, `drmsTolPct` × 現在DRMS)**
     （既定 0.3 m または 5%）
   → 停止理由 `converged`
2. **タイムアウト停止**（既存動作を維持）
   - `maxSec > 0 && elapsedSec >= maxSec` → 停止理由 `timeout`
   - `maxEpochs > 0 && samples.length >= maxEpochs` → 停止理由 `maxEpochs`
3. **手動停止**（既存の停止ボタン）→ 停止理由 `manual`

**品質ゲート**（そのエポックが収束判定に使えるか）：

```
fixMode === 3            // 3D 測位
&& hdop != null && hdop <= 3
&& satsUsed != null && satsUsed >= 5
```

- 品質ゲートを満たさないエポックが来たら**収束用の履歴をリセット**する
  （＝「安定してから10秒」の連続カウントをやり直す）。
- 記録用サンプル（`st.samples`）への蓄積条件は**現状のまま**（`lat != null && fixQuality > 0`）。
  収束判定のゲートは停止用途のみで、記録データは間引かない。

## 2. パラメータと既定値

| 名前 | 既定値 | 種別 | 説明 |
|---|---|---|---|
| `staticAutoStop` | `true` | 設定（永続化） | 収束による自動停止 ON/OFF |
| `staticMinSec` (`minSec`) | `30` 秒 | 設定（永続化） | これ未満では絶対に停止しない |
| `staticMaxSec` (`maxSec`) | `60` 秒（既存） | 設定（永続化） | **上限＝タイムアウト**として利用。0 で無制限 |
| `staticMaxEpochs` (`maxEpochs`) | `120`（既存） | 設定（永続化） | 上限エポック数。0 で無制限 |
| `holdSec` | `10` 秒 | 定数 | 収束が維持されるべき時間 |
| `centerTolM` | `0.3` m | 定数 | 直近 `holdSec` の中心許容移動 |
| `drmsTolAbsM` | `0.3` m | 定数 | DRMS 許容変動（絶対） |
| `drmsTolPct` | `0.05`（5%） | 定数 | DRMS 許容変動（相対） |

- **設定画面に出す**のは `staticAutoStop` と `staticMinSec` の2つ、および既存 `staticMaxSec` の
  ラベルを「上限時間（タイムアウト）」に変更するのみ。
- `holdSec` / 各許容値は**モジュール定数**として持ち、設定画面には出さない（画面の煩雑化回避）。
  値は `js/recorder.js`（または収束モジュール）先頭に `const CONVERGENCE = {...}` で定義。

## 3. 実装箇所

### 3-1. 収束判定の純粋関数（テスト可能に）
`js/accuracy.js` に純粋関数を追加する（既存 `metersPerDegree` を再利用できるため）。

```js
// 収束用の中心/DRMS 履歴から、直近 holdSec 窓での安定性を評価する純粋関数。
// history: [{ t, lat, lon, drms }]（t=経過秒, 中心lat/lon, その時点のDRMS）を時刻昇順で受ける。
// 返り値: { stable: boolean, centerMoveM: number|null, drmsRangeM: number|null }
export function evaluateConvergence(history, elapsedSec, opts) {
  const { minSec, holdSec, centerTolM, drmsTolAbsM, drmsTolPct } = opts;
  if (elapsedSec < minSec || history.length < 2) return { stable: false, centerMoveM: null, drmsRangeM: null };

  const cutoff = elapsedSec - holdSec;
  // holdSec 秒前以前の基準点（連続した良好データが holdSec 以上あるか）
  let ref = null;
  for (const h of history) { if (h.t <= cutoff) ref = h; else break; }
  if (!ref) return { stable: false, centerMoveM: null, drmsRangeM: null }; // 窓を満たしていない

  const cur = history[history.length - 1];
  const { latM, lonM } = metersPerDegree(cur.lat);
  const centerMoveM = Math.hypot((cur.lon - ref.lon) * lonM, (cur.lat - ref.lat) * latM);

  const win = history.filter((h) => h.t >= ref.t);
  const drmsVals = win.map((h) => h.drms).filter((v) => v != null);
  const drmsRangeM = drmsVals.length ? Math.max(...drmsVals) - Math.min(...drmsVals) : 0;

  const drmsTol = Math.max(drmsTolAbsM, drmsTolPct * (cur.drms || 0));
  const stable = centerMoveM <= centerTolM && drmsRangeM <= drmsTol;
  return { stable, centerMoveM, drmsRangeM };
}
```

### 3-2. `js/recorder.js`
- 先頭に収束定数を定義：
  ```js
  const CONVERGENCE = { holdSec: 10, centerTolM: 0.3, drmsTolAbsM: 0.3, drmsTolPct: 0.05 };
  ```
- `import { computeStaticStats, evaluateConvergence } from './accuracy.js';`
- `startStatic({ ... })` の引数に `autoStop`（bool）と `minSec` を追加。
  `this.static` に次を追加：`autoStop`, `minSec`, `convHistory: []`。
- `addEpoch(epoch)`：既存のサンプル追加・`computeStaticStats`・`onStaticUpdate` の**後**に
  収束処理を挿入（下記 6. 疑似コード）。
- `stopStatic(reason = 'manual')` に停止理由を追加し、
  `session.summary.stopReason = reason` を格納。`onStaticStop(session)` はそのまま。
  自動停止経路からは `stopStatic('converged' | 'timeout' | 'maxEpochs')` で呼ぶ。
- `onStaticUpdate` のペイロードに収束状況を含める：
  `{ count, elapsedSec, stats, convergence: { stable, centerMoveM, drmsRangeM } | null }`。

### 3-3. `js/app.js`
- `DEFAULT_SETTINGS` に追加：`staticAutoStop: true`, `staticMinSec: 30`。
- 静的測位開始（`btn-static`）で `recorder.startStatic({ ..., autoStop: settings.staticAutoStop, minSec: settings.staticMinSec })`。
- 収集中ライブ表示（`onStaticUpdate`）で、収束状況を表示（下記 5. UI）。
- `onStaticStopped(session)` で `session.summary.stopReason` を停止理由テキストに反映。

### 3-4. `js/settings-ui.js` ＋ `index.html`
- `#page-settings` に入力を追加：
  - チェックボックス `#set-autostop`（収束で自動停止）
  - 数値 `#set-minsec`（最低収集時間[秒]）
- 既存 `#set-maxsec` のラベルを「静的測位 上限時間 [秒]（0=無制限・タイムアウト）」に変更。
- `initSettingsUI` に上記2項目の初期値反映と `change` ハンドラ（`settings` 更新＋`storage.setSetting`）を追加。

### 3-5. `js/format.js`
- 停止理由ラベルを追加し、`formatStats` の先頭行または `static-result` に反映：
  ```js
  export const STOP_REASON = {
    converged: '収束（中心・DRMS横ばい）',
    timeout: '上限時間到達（未収束）',
    maxEpochs: '上限エポック到達',
    manual: '手動停止',
  };
  ```

### 3-6. ドキュメント
- `docs/design-202606.md` の `recorder.js` 行に「収束自動停止（最低時間＋収束維持）」を追記。
- `docs/RequiredSpec-202606.md` に該当仕様があれば追記（無ければ本ファイルを参照リンク）。

## 4. データ構造（`this.static` 追加分）

```
this.static = {
  label, memo, startedAt, samples, maxSec, maxEpochs, paused, // 既存
  autoStop,          // bool: 収束自動停止の有効/無効
  minSec,            // number: 最低収集時間[秒]
  convHistory,       // [{ t, lat, lon, drms }] 品質ゲート通過エポックのみ。bad で []
}
```

## 5. UI 仕様

- **収集中ライブ表示**（`#static-live` 内、任意で1項目追加可）：
  - 収束 ON かつ品質ゲート通過中：`収束判定: 安定 X.X m / DRMS±Y.Y m`（`centerMoveM`/`drmsRangeM` を表示）
  - 品質不良でリセット中：`収束判定: 待機中（品質不足）`
  - `minSec` 未到達：`収束判定: 最低時間まで残り Z 秒`
  - 実装を最小化する場合は、少なくとも**品質不良中である旨**が分かる表示を1つ出す。
- **停止時**（`#static-result`）：先頭に停止理由を表示。
  例：`自動停止: 収束（中心・DRMS横ばい）` / `自動停止: 上限時間到達（未収束）`。
  → 森林等で `timeout` の場合は値の信頼度が低いことが一目で分かる。

## 6. `addEpoch` 収束処理の疑似コード

```
addEpoch(epoch):
  latestEpoch = epoch
  st = this.static
  if !st or st.paused: return
  if epoch.lat == null or epoch.lon == null or !(epoch.fixQuality > 0): return

  st.samples.push(toSample(epoch))
  elapsedSec = (now - st.startedAt)/1000
  stats = computeStaticStats(st.samples)
  onStaticUpdate({ count, elapsedSec, stats, convergence: lastConv })   // lastConv は下で算出

  // ---- 収束自動停止 ----
  if st.autoStop:
    if qualityOk(epoch):                      // fixMode===3 && hdop<=3 && satsUsed>=5
      st.convHistory.push({ t: elapsedSec, lat: stats.center.lat, lon: stats.center.lon, drms: stats.drms })
      // 古すぎる履歴は間引く（holdSec+α だけ残す。基準点確保のため cutoff より1つ古いのは残す）
      trim st.convHistory to entries with t >= elapsedSec - holdSec - 5   // 目安
      conv = evaluateConvergence(st.convHistory, elapsedSec, { minSec: st.minSec, ...CONVERGENCE })
      if conv.stable:
        return this.stopStatic('converged')
    else:
      st.convHistory = []                     // 品質不良で連続性リセット

  // ---- タイムアウト（既存動作） ----
  if st.maxSec > 0 and elapsedSec >= st.maxSec:      return this.stopStatic('timeout')
  if st.maxEpochs > 0 and st.samples.length >= st.maxEpochs: return this.stopStatic('maxEpochs')
```

`qualityOk(epoch)` は `recorder.js` 内のローカル関数として実装（純粋・DOM非依存）。

## 7. 注意事項・非機能要件

- **相関の影響**：1Hz の連続サンプルは相関が強いため、`holdSec` を短くしすぎない（10秒を既定とする）。
- **品質ゲート必須**：これが無いと“安定して偏った”値で早期停止し得る。省略しないこと。
- **上限の扱い**：`autoStop` が ON でも `maxSec`/`maxEpochs` はタイムアウトとして必ず有効。
  `maxSec = 0`（無制限）にする場合、未収束環境では停止しなくなる旨をラベルで注意喚起する。
  収束に余裕を持たせたい場合は `maxSec` を大きめ（例 300）に設定できることを設定説明に記す。
- **既存挙動の維持**：`staticAutoStop = false` のときは**現状と完全に同じ**（maxSec/maxEpochs のみ）。
- **後方互換**：既存の保存セッションに `stopReason` が無い場合、表示は空（`manual` 相当）にフォールバック。

## 8. 受け入れ基準

1. 空の開けた場所（HDOP 良好・3D）で収集 → **概ね30〜45秒で `converged` 停止**、
   `#static-result` に「収束」と表示される。
2. 品質不良（HDOP>3 や 2D）が続く環境 → 収束せず、`maxSec` 到達で `timeout` 停止し、
   「上限時間到達（未収束）」と表示される。
3. 収集中に品質不良エポックを挟むと収束カウントがリセットされ、良好が10秒続くまで停止しない。
4. `staticAutoStop = false` で既存どおり `maxSec`/`maxEpochs` のみで停止する。
5. 手動停止時は `manual` と記録・表示される。
6. `node tools/check-syntax.mjs` が**全 OK**（下記テスト追加込み）。

## 9. テスト（`tools/check-syntax.mjs` に追加）

`evaluateConvergence` の純粋関数を合成データで検証する：

- **横ばい列**（中心固定・DRMS一定）で `elapsedSec >= minSec` かつ窓充足 → `stable === true`。
- **ドリフト列**（中心が毎秒 0.2 m 動く＝10秒で 2 m）→ `centerMoveM > centerTolM` で `stable === false`。
- **DRMS 変動列**（DRMS が窓内で 1 m 変動）→ `drmsRangeM > drmsTol` で `stable === false`。
- **時間不足**（`elapsedSec < minSec`）→ `stable === false`。
- **窓未充足**（履歴が holdSec 未満）→ `stable === false`。

---

### 実装順序（推奨）
1. `accuracy.js`：`evaluateConvergence` 追加 ＋ テスト追加（先に純粋ロジックを固める）。
2. `recorder.js`：`startStatic`/`addEpoch`/`stopStatic` 拡張。
3. `app.js`：設定既定値・`startStatic` 引数・停止理由表示。
4. `settings-ui.js` ＋ `index.html`：設定UI追加。
5. `format.js`：`STOP_REASON`。
6. ドキュメント更新 ＋ `check-syntax.mjs` 実行で検証。
