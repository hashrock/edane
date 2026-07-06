# ADR 0001: ホイール／トラックパッドのパン・ズーム判定

- ステータス: Accepted
- 日付: 2026-07-06
- 対象コード: `app/lib/panZoom.ts`, `app/components/stagePanZoom.ts`

## コンテキスト

Konva ステージ上で、1 本の DOM `wheel` イベントストリームに **3 つの異なるユーザー意図**が乗ってくる。

| 入力デバイス／操作 | 期待する動作 |
| --- | --- |
| マウスホイール回転 | ズーム（従来どおりの固定ステップ ×1.05） |
| トラックパッド 2 本指スクロール | パン（コンテンツが指に追従） |
| トラックパッド ピンチ | 滑らかなズーム（指の移動量に比例） |

ブラウザは `wheel` イベントに**デバイス種別を明示しない**。そのため各イベントをヒューリスティックで分類する必要がある。

### 実測した macOS Chrome のイベント値（判定の根拠）

```
# マウスホイール（ズームしたい） — ctrlKey: false
deltaY  -120        wheelDeltaY  360     (整数)
deltaY  -124.124…   wheelDeltaY  360     (加速で非整数)
deltaY  -168.018…   wheelDeltaY  480
deltaY   208.441…   wheelDeltaY -600

# トラックパッド ピンチ — ctrlKey: true
deltaY  7.200…      wheelDeltaY -120     (非整数, |wheelDeltaY| は 120 固定)
deltaY -3.440…      wheelDeltaY  120
```

ここから読み取れる決定的な事実:

1. `deltaY` は **OS のスクロール加速でどちらのデバイスでも非整数になりうる**。
   → 「非整数なら trackpad」という単純判定は、速く回したマウスを誤ってパンにしてしまう。
2. `wheelDeltaY`（WebKit/Chrome 系）は信頼できる:
   - マウス: `3 × (ノッチ数 × ±120)`。速く回すとノッチが束ねられ **`|wheelDeltaY|` が 360, 480, 600 … と増える**。
   - トラックパッド ピンチ: **`|wheelDeltaY|` は 120 に張り付く**。
   - トラックパッド スクロール: `-3 × deltaY` で、**120 の倍数になることはめったにない**。

## 決定

`wheelDeltaY` の **値と絶対値**を第一級のシグナルとして使い、`deltaY` の整数／非整数はフォールバックに降格する。加えて、単発では判別できないイベントは「バースト記憶」で直近のデバイスを継承する。

### デバイス判定（`detectDevice`）

```
function detectDevice(e):
    # 行／ページ単位の delta は本物のホイールだけ（例: Firefox のマウス）
    if e.deltaMode != 0:
        return MOUSE

    # wheelDeltaY が使えるなら、delta の形より先に必ず優先する
    if e.wheelDeltaY is present and e.wheelDeltaY != 0:
        # 120 の倍数でない → トラックパッドの確たる証拠（-3*deltaY はまず 120 に乗らない）
        if e.wheelDeltaY % 120 != 0:
            return TRACKPAD
        # 複数ノッチ分の加速 = 本物のホイールだけが出せる（ピンチは ±120 固定）
        # → deltaY が非整数でもマウス。これが「速いマウス回転をズームに保つ」肝
        if abs(e.wheelDeltaY) > 120:
            return MOUSE
        # ちょうど ±120 = マウス 1 ノッチとピンチが区別できない。
        #   非整数 deltaY ならピンチ（→ 滑らかズーム）
        #   整数 deltaY なら曖昧（1 ノッチ）→ null でバースト/既定に委ねる
        if not isInteger(e.deltaY):
            return TRACKPAD
        return null   # 曖昧

    # wheelDeltaY が無い環境（例: Firefox）→ delta の形にフォールバック
    if not isInteger(e.deltaX) or not isInteger(e.deltaY):
        return TRACKPAD          # サブピクセル精度はトラックパッドのみ
    if e.deltaX != 0:
        return TRACKPAD          # 横成分はトラックパッド（または shift+wheel＝どのみち横パン）
    return null                  # 整数・縦のみ = 曖昧
```

### バースト記憶付き分類（`createWheelGestureRecognizer`）

単発で `null`（曖昧）なイベントは、直近 `GESTURE_BURST_MS`（300ms）以内なら
直前のデバイスを継承する。ストリームの先頭が曖昧なら **MOUSE を既定**にする
（＝トラックパッド以前の「ホイール＝ズーム」挙動を安全なフォールバックとして保つ）。

```
state: lastDevice = MOUSE, lastTime = -inf

function recognize(e):
    detected = detectDevice(e)
    inBurst  = (e.timeStamp - lastTime) < GESTURE_BURST_MS
    device   = detected ?? (inBurst ? lastDevice : MOUSE)
    lastDevice = device
    lastTime   = e.timeStamp

    if e.ctrlKey:                     # ピンチ or ctrl+ホイール（必ずズーム）
        if device == TRACKPAD:
            factor = exp(-e.deltaY * PINCH_ZOOM_SPEED)   # 滑らか・指移動量に比例
        else:
            factor = stepZoomFactor(e.deltaY)            # 従来の固定ステップ
        return ZOOM(factor)

    if device == TRACKPAD:
        return PAN(dx = -e.deltaX, dy = -e.deltaY)       # 符号反転で指に追従

    return ZOOM(stepZoomFactor(e.deltaY))                # マウスホイール = ステップズーム
```

`ctrlKey` の有無で「パン/ズームの混在が起きるストリーム」と「必ずズームになる
ストリーム」が完全に分離される点が重要:

- `ctrlKey = false`: 通常スクロール。`wheelDeltaY` 優先ロジックでパンかズームを決める。
- `ctrlKey = true`: ピンチ or ctrl+ホイール。**必ずズーム**なのでパン混在は起きず、
  `device` は「滑らか(exp)か固定ステップか」を選ぶだけに使う。

### 変換の数式（純粋関数）

```
stepZoomFactor(deltaY):          # 古典的ホイールズーム、1 イベント = 1 ステップ
    return deltaY > 0 ? 1/WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP     # 下=縮小, 上=拡大

zoomAt(t, anchor, factor):       # anchor(スクリーン座標) の下のワールド点を固定して拡縮
    scale  = clamp(t.scale * factor, MIN_SCALE, MAX_SCALE)
    world  = screenToWorld(anchor, t)
    offset = offsetToAnchor(world, scale, anchor)
    return { scale, offsetX: offset.x, offsetY: offset.y }

panBy(t, dx, dy):                # スクリーン空間の平行移動（scale はそのまま）
    return { scale: t.scale, offsetX: t.offsetX + dx, offsetY: t.offsetY + dy }
```

定数: `MIN_SCALE = 0.2`, `MAX_SCALE = 3`, `WHEEL_ZOOM_STEP = 1.05`,
`PINCH_ZOOM_SPEED = 0.01`, `GESTURE_BURST_MS = 300`。

### Safari のピンチ（`stagePanZoom.ts`）

Safari は ctrl+wheel ではなく独自の `GestureEvent`（`gesturestart` / `gesturechange`
/ `gestureend`）でピンチを報告する。`e.scale` は gesturestart からの**累積値**なので、
開始時に捕捉した変換に対して `zoomAt(base, anchor, e.scale / startScale)` を都度適用する。
リスナはコンテナ要素（ステージより長命）に付くため、クリーンアップで明示的に外す。

## 検討した代替案と却下理由

- **「非整数 deltaY なら trackpad」だけで判定**（初期実装）
  → 加速で非整数化した速いマウス回転をパンと誤判定し、ズームとパンが混在した。却下。
- **`wheelDeltaY % 120 != 0` だけで trackpad 判定**（前段の修正）
  → マウス速回しは直ったが、ピンチも `wheelDeltaY = ±120` のため MOUSE 寄りに倒れ、
    滑らかズームが固定ステップに劣化した。却下。
- **`ctrlKey` なら常にトラックパッドピンチとみなす**
  → ctrl+物理マウスホイールの従来ステップズーム挙動（テストで固定）を壊すため不採用。
    代わりに `ctrlKey` 内でも `device` 判定を残した。

## 結果

- マウスホイール: 回転速度によらずズーム一貫（パン混在なし）。
- トラックパッド 2 本指: パン（指に追従）。
- トラックパッド ピンチ: 滑らかな指数ズーム。
- 判定・変換ロジックは DOM 非依存の純粋関数として `app/lib/panZoom.ts` に集約し、
  `app/lib/panZoom.test.ts` で実測値を使ったリグレッションテストを含めて単体テスト済み。
