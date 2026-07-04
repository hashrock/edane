# Round 6 — ツリーレイアウトの縦サイズ計算（非重複）を Alloy で検証

センタリング機能の土台として整理した「ノード・枝のサイズ計算系」のうち、
最も重要な構造不変条件 — `app/lib/treeLayout.ts` の `subtreeHeight` 再帰が
**レイアウトの縦方向の重なりを防ぐ** こと — を Alloy 6 で有界モデル検査した記録。

## 検証した契約

```
slotHeight(n)    = max(NODE_MIN_HEIGHT, measuredHeight)          // 自分のボックス "own"
subtreeHeight(n) = 葉    ? slotHeight(n)
                        : max( slotHeight(n),                     // ← この max が要
                               Σ子 subtreeHeight + (子数-1)*VGAP )
```

`assignNodePositions` は各ノードに高さ `subtreeHeight` の**縦の帯**を割り当て、
その中に子を連続配置し、自分のボックスを帯の中央に置く。レイアウトが重ならない
必要十分条件は「帯が自分のボックスと子ブロックの両方を収められること」＝次の対:

- **(I1)** `subtreeHeight(n) >= slotHeight(n)` … 自分のボックスが帯に収まる
- **(I2)** `subtreeHeight(n) >= childrenBlock(n)` … 子ブロックが帯に収まる
  （`childrenBlock(n) = Σ子 subtreeHeight + (子数-1)*VGAP`）

I1・I2 が成り立てば、子は帯内の互いに素な連続区間（総長 `childrenBlock` ≤ 帯）に
並び、自分のボックスも帯内に収まるので、帰納的にどの2つのノードボックスも重ならない。
I1・I2 はまさに `max(own, childrenBlock)` が保証するもの。

## 結果（scope: 5ノード / Int 7bit）

| コマンド | 種別 | 結果 | 意味 |
|---|---|---|---|
| `RecurrenceEstablishesFit` | check | **UNSAT（反例なし）** | max 版の再帰が全ノードで I1・I2 を確立 ✓ |
| `WellSizedTallParentExists` | run | SATISFIABLE | 背の高い親（own > 子ブロック）が実在＝checkが空虚でない ✓ |
| `OverflowWithoutMax` | run | SATISFIABLE | max を外すと帯がボックスより低くなる（下記）|

## `max(own, …)` が load-bearing であることの反例

`wellSizedNoMax`（`subtreeHeight = childrenBlock`、own を無視）では、Alloy が即座に
「自分のボックスが帯からはみ出す」インスタンスを発見:

```
own:  Node1 = 2   （親のボックス高さ）
kids: Node1 → Node0
own:  Node0 = 1   （子）
childrenBlock(Node1) = Σ子sh(=1) + (1-1)*VGAP = 1
sh:   Node1 = 1   ← max なしなので子ブロックの 1。だが own=2 > 1
```

親 Node1 は自分のボックス高さ 2 に対し帯 1 しか確保されず、ボックスが帯を突き抜けて
隣の兄弟の帯へ食い込む＝重なり。実コードの
`Math.max(layout.height, childrenHeight)`（treeLayout.ts の
`calculateSubtreeHeight`、コメント「A tall (multi-line) parent must not be shorter
than its own box.」）がこの重なりを防いでいる。round5 の循環ガード g3 と同様、
Alloy はガード（ここでは `max`）を外した途端に破綻が生じることを示した。

## 前提と限界

- **位置は帯確保の不変条件として抽象化**。Alloy モデルは各ノードの帯高さ `sh` と
  I1・I2 の充足を扱い、絶対 y 座標や子の並び順（プレフィックス和）は表現しない。
  I1・I2 から絶対座標の非重複が従うのは「互いに素な連続区間」という初等的な算術で、
  Alloy が付加価値を持つ部分ではないため。
- **VGAP は定数 1**、own 高さは `1..4` に有界化（帯の高さ比だけが本質で、Int の桁
  あふれを避けるため）。scope 5ノード・Int 7bit。small scope 仮説のもと、max 反例は
  2ノードで出た。
- センタリングそのもの（`app/lib/viewport.ts` の world↔screen / centerOffset）は実数
  アフィン変換で、Alloy より数値の単体テスト（`app/lib/viewport.test.ts`）が適任。
  本ラウンドは「枝のサイズ計算」の構造不変条件に集中している。

## 実行

```bash
cd formal/round6/alloy
# 21MB の solver jar が無ければ Maven Central から取得（他ラウンドのものを流用可）
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
ALLOY_JAR=alloy.jar ./run.sh
```

macOS で Java が無い場合は `brew install openjdk` 後、
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`。
