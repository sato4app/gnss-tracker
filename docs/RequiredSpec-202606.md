# GNSS 受信・解析 PWA 設計プロンプト

> このファイルは Claude Code / Cursor にそのまま貼り付けて使う「設計・実装用プロンプト」です。
> 既存の GNSS 解析 PWA 資産（NMEA パーサ / エポックアセンブラ / sky plot / SNR チャート / IndexedDB レコーダ / mock feeder）がある場合は、それを土台に拡張してください。

---

## 役割

あなたは Vanilla JS（フレームワーク不使用）・ES モジュール構成に習熟したフロントエンドエンジニアです。
以下の要件で **GNSS 受信・解析 PWA** を設計・実装してください。まず全体設計（ファイル構成・データモデル・モジュール責務）を提示し、合意後に各モジュールを実装します。勝手に外部フレームワークやビルドツールを導入しないこと。

---

## 1. システム構成（前提・変更不可）

```
[u-blox MAX-M10S] --UART(9600)--> [Raspberry Pi Pico W] --BLE(NUS notify)--> [Android スマホ Chrome / 本PWA]
```

- Pico W 側ファーム（`main.py`）は **生 NMEA を一切パースせず、無加工で全種類を BLE で配信する「ダムパイプ」**。ファームは変更しない前提で受信側を作る。
- パース・判定・地図表示・記録は **すべて本 PWA（受信側）で行う**。
- **接続方式は BLE（Web Bluetooth）専用**。WebSocket 経路は実装しない。
  - 理由: PWA を HTTPS（Vercel）配信したまま接続できる。`ws://` への mixed content ブロックを完全に回避するため。
  - iOS は Web Bluetooth 非対応のため対象外。**Android Chrome 前提**で最適化する。

### BLE 接続仕様（Pico W の `main.py` と一致させること）

- 広告名（デバイス名）: `picow`
- Nordic UART Service（NUS）UUID:
  - Service: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
  - TX（周辺→中央 / **notify**, 受信に使う）: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`
  - RX（中央→周辺 / write, **未使用**）: `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- notify は **ATT_MTU−3（既定 20 バイト）ごとに分割**されて届く。Pico 側は各行末に `\n` を付与している。
  → 受信側で **チャンクを連結 → `\n` で行分割** して 1 NMEA センテンスに復元する。
- 復元した各行は **チェックサム（`*XX`）を検証**し、途中で途切れた壊れた行は捨てる（Pico 側でも分割送信失敗時に行が欠ける可能性があるため必須）。

---

## 2. 技術スタック（踏襲）

- **Vanilla JS（ES モジュール）** — フレームワーク・バンドラ不使用。`<script type="module">` で読み込む。
- **Leaflet.js** — 地図表示。
- **地理院地図（GSI）タイル** — 標準地図 / 淡色地図 / 写真を切替可能に。既定ズーム **z=17**。
- **IndexedDB** — 記録データの永続化（**端末内のみ・オフライン完結**。サーバ同期は行わない）。
- **Service Worker + Cache API** — アプリシェル + 地図タイルのオフラインキャッシュ。
- **PWA**（`manifest.json` / アイコン / インストール対応）。
- **Wake Lock API** — 記録中の画面維持。
- 外部送信なし。Firebase 等のバックエンドは使わない。

---

## 3. 機能要件

### 3-1. BLE 接続
- 「接続」ボタン（**ユーザー操作必須**：`requestDevice` は user gesture 内で呼ぶ）。
  - `filters: [{ name: 'picow' }]`、`optionalServices: [NUS_SERVICE_UUID]`。
- TX キャラクタリスティックの `startNotifications()` ＋ `characteristicvaluechanged` で受信。
- 接続状態の表示（未接続 / 接続中 / 受信中）。最終受信からの経過秒も表示。
- `gattserverdisconnected` を監視し、**自動再接続**（指数バックオフ）。手動切断と区別する。
- BLE はバックグラウンドで切れるため、**記録中は Wake Lock で画面を保つ**こと（後述）。

### 3-2. NMEA パース（対象センテンス）
talker ID は複合測位で `GN` になることが多い。系統別 GSV は `GP/GL/GA/GB/GQ`。以下を解析する:

| センテンス | 取得する主な値 |
|---|---|
| `GGA` | UTC 時刻, 緯度経度, **fix quality**(0=測位不能 / 1=GPS / 2=DGPS / 4=RTK Fixed / 5=RTK Float), 使用衛星数, **HDOP**, 標高, ジオイド高 |
| `GSA` | 測位モード(1=無/2=2D/3=3D), **PDOP / HDOP / VDOP**, 使用衛星 PRN |
| `GSV` | 視野内衛星数, 各衛星の PRN / **仰角 / 方位角 / SNR(C/N0)**（sky plot・SNR チャート用） |
| `RMC` | 日時(UTC), 緯度経度, 対地速度, 進路, ステータス |
| `VTG` | 対地速度・進路（任意） |
| `GST`（任意） | 緯度経度の標準偏差など擬似距離誤差統計。**M10S が出力していれば**水平精度を直接推定可能 |

- マルチ GNSS（GPS / GLONASS / Galileo / BeiDou / QZSS）対応。系統判別を保持する。
- `GSV` は複数メッセージに分割（total / msg index）。**全 GSV を集約**して 1 エポック分の衛星リストにまとめる。

### 3-3. エポックアセンブラ
- 同一時刻のセンテンス群（GGA/RMC/GSA/GSV…）を **1 エポック**に組み立てる。
- 1 エポックの構造（例）:
  ```
  {
    t: Date,                 // UTC
    lat, lon, altMSL,        // 位置・標高
    fixQuality, fixMode,     // fix 種別
    satsUsed, satsInView,    // 衛星数
    pdop, hdop, vdop,        // DOP
    satellites: [            // 系統別・SNR 付き（sky plot 用）
      { sys, prn, elev, azim, snr, used }
    ],
    speed, course,
    latStd, lonStd           // GST があれば
  }
  ```
- 新エポック確定ごとにイベントを発火し、地図・解析・記録の各モジュールが購読する。

### 3-4. 地図表示（Leaflet + 地理院地図）
- 現在地マーカー＋**水平精度円**（推定水平精度の半径）。
- 軌跡ポリライン（任意・ON/OFF）。
- 記録地点マーカー（スナップショット / 静的測位の中心）。
- 地図種別切替（標準 / 淡色 / 写真）、既定 z=17。
- 「現在地に追従」トグル。

### 3-5. GNSS 精度の分析・表示
- **fix 種別バッジ**（No fix / 2D / 3D / DGPS / RTK Float / RTK Fixed を色分け）。
- 衛星数（使用 / 視野内）と**系統別内訳**。
- **DOP**（PDOP / HDOP / VDOP）数値＋簡易バー。
- **SNR チャート**（衛星別バー。系統別に色分け。SNR 低い衛星が一目で分かる）。
- **sky plot**（極座標：半径＝仰角、角度＝方位、点色＝SNR、形/色＝系統。使用衛星を強調）。
- **水平精度の推定**（優先順）:
  1. `GST` があれば lat/lon 標準偏差から DRMS。
  2. 無ければ `HDOP × UERE`（UERE は設定値、既定 例 5 m）で概算。
  3. 静的測位記録中は**実測ばらつき**も併記。

### 3-6. 特定地点の GNSS 値の記録（**両モード実装**）

**(A) スナップショット記録**
- ボタン押下で **現在エポックの 1 点**を保存。任意ラベル・メモを付与。

**(B) 静的測位記録**
- 「開始」で一点に留まり、**N 秒 or M エポック**を連続収集 →「停止」で集計。
- 集計指標:
  - 平均緯度経度（および中央値）
  - 緯度経度の標準偏差 → 東西 / 南北方向の **m 換算**
  - 水平 **DRMS / 2DRMS**
  - **CEP50（CEP）/ CEP95（R95）**
  - 標高 平均・標準偏差
  - 収集エポック数、fix 種別の内訳、平均 DOP・平均衛星数
  - 中心からのオフセット**散布図**（東西 m × 南北 m）
- 収集中はライブで「現在の点数 / 経過時間 / 暫定ばらつき」を表示。

**共通**
- 記録は **IndexedDB** に保存（後述スキーマ）。
- **エクスポート**: CSV / GPX / JSON（生エポック群＋集計値）を出力可能に。
- 記録一覧（セッション/地点）の閲覧・地図表示・削除。

### 3-7. Wake Lock（記録は画面表示中のみ）
- 記録（特に静的測位）開始時に `navigator.wakeLock.request('screen')`。
- `visibilitychange` で画面復帰時に**再取得**。
- **画面 OFF / バックグラウンド → BLE 切断 ＆ 記録一時停止**。UI に「記録は画面表示中のみ有効」を明示する。
- 記録停止・セッション終了で `release()`。

### 3-8. オフライン（PWA）
- `manifest.json`＋アイコン（既存アイコン生成パイプラインの流儀に合わせて可）。
- **Service Worker**: アプリシェルはプリキャッシュ。地図タイルは Cache API に格納（cache-first＋必要に応じ更新）。
- **`tile_manifest.json`** による事前ダウンロード（Format A：座標リスト JSON 方式）。
  - マニフェスト記載タイルを Cache API に一括取得するボタン／進捗表示。
  - 対象範囲・ズーム（既定 z=17）を設定可能に。
- オフライン時も：地図（キャッシュ済範囲）／BLE 受信／解析／記録が**完全動作**すること。

### 3-9. 開発用 mock feeder
- BLE 実機が無くても開発できるよう、**サンプル NMEA を擬似配信するモック**を用意（既存資産があれば踏襲）。
- 実 BLE と同じイベント I/F で差し替え可能にし、UI から ON/OFF 切替。

---

## 4. 想定ファイル構成（ES モジュール）

```
/
├─ index.html
├─ manifest.json
├─ sw.js                  # Service Worker（アプリシェル＋タイルキャッシュ）
├─ tile_manifest.json     # 事前DL対象タイル（Format A 座標リスト）
├─ css/
│   └─ style.css
├─ icons/                 # PWA アイコン一式
└─ js/
    ├─ app.js             # エントリ：各モジュール結線・イベントバス
    ├─ ble-client.js      # Web Bluetooth(NUS) 接続・チャンク結合・行復元
    ├─ nmea-parser.js     # GGA/GSA/GSV/RMC/VTG/GST パーサ＋チェックサム検証
    ├─ epoch-assembler.js # 同一時刻センテンス群 → 1エポック
    ├─ accuracy.js        # DOP/UERE/DRMS/CEP/RMS 等の算出
    ├─ map.js             # Leaflet＋地理院地図・マーカー・精度円・軌跡
    ├─ sky-plot.js        # スカイプロット描画
    ├─ snr-chart.js       # SNR チャート描画
    ├─ recorder.js        # スナップショット／静的測位の制御・集計
    ├─ storage.js         # IndexedDB ラッパ
    ├─ exporter.js        # CSV / GPX / JSON 出力
    ├─ wake-lock.js       # Wake Lock 管理
    ├─ tile-cache.js      # tile_manifest 事前DL＋Cache API
    └─ mock-feeder.js     # 開発用 擬似 NMEA 配信
```

> 既存の parser / epoch-assembler / sky-plot / snr-chart / recorder / mock-feeder があれば**新規作成せず流用・拡張**すること。

---

## 5. IndexedDB スキーマ（端末内のみ）

DB 名は既存に合わせて可（例 `gnssDB`）。オブジェクトストア:

- **`sessions`**: 記録セッションのメタ（id, type: `snapshot` | `static`, label, createdAt, 集計値サマリ）。
- **`points`**: 記録地点（sessionId 紐付け。snapshot は 1 点、static は中心＋集計＋生エポック群）。
- **`settings`**: UERE・既定収集時間/点数・タイルズーム・地図種別・軌跡 ON/OFF など。
- （任意）**`rawlog`**: 生 NMEA ログ（デバッグ用。容量管理に注意）。

---

## 6. UI 構成（モバイル縦持ち前提）

- **上部バー**: 接続ボタン / 接続状態 / fix 種別バッジ / 最終受信経過。
- **地図（メイン領域）**。
- **下部タブ or スワイプパネル**:
  1. **ライブ**: 現在位置・推定精度・使用/視野内衛星・DOP。
  2. **解析**: sky plot ＋ SNR チャート ＋ DOP 詳細。
  3. **記録**: スナップショット保存ボタン / 静的測位 開始・停止 / 収集状況 / 記録一覧・エクスポート。
- **設定**: UERE、収集時間・点数、タイル事前 DL、地図種別。

---

## 7. 実装時の注意

- BLE notify は高頻度（最大 1 Hz×複数センテンス）。**受信バッファとパースを軽量に**。再描画は requestAnimationFrame でスロットリング。
- チェックサム不一致・欠損行は**黙って捨てる**（接続は維持）。エラーで停止しない堅牢設計。
- 緯度経度 ↔ メートル換算は局所平面近似（緯度に応じた 1度あたり m）で十分。
- すべてオフラインで動くこと（CDN 依存を避け、Leaflet も含めローカル配置 or キャッシュ）。
- 既存のコード規約・命名（ポイント/ルート/スポット等の日本語データ用語、LocalStorage 設定管理の流儀）と整合させる。

---

## 8. 着手前に確認したい未確定事項（あれば回答ください）

1. **`GST` センテンス**を M10S が出力するよう設定済みか（UBX-CFG）。出ていれば水平精度を直接推定できるが、無ければ HDOP×UERE 概算にフォールバックする。
2. 静的測位の**既定収集条件**（例：60 秒 / または 120 エポック）。
3. UERE の既定値（例：5 m）。
4. アプリ名・パッケージ名（PWA 表示名）。
5. 既存 GNSS PWA リポジトリへの追加か、新規リポジトリか（既存なら現状のファイル構成を教えてください。それに合わせます）。

---

### まず出力してほしいもの
1. 上記を踏まえた**全体設計**（モジュール責務・データフロー・イベントバス設計・IndexedDB スキーマ確定版）。
2. 実装順序の提案（例：mock-feeder → parser/assembler → 解析表示 → 地図 → 記録 → PWA/オフライン → BLE 実機結合）。

設計に合意できたら、モジュール単位で実装を進めてください。