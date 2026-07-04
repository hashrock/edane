# Round 7 — センタリングのアフィン変換（Z3）と D&D ライフサイクル（TLA+）

Alloy round5/6 が扱わなかった2つの側面を、それぞれ得意なツールで検証した記録。

- **Z3** … ビューポート変換の**実数演算**を全域証明（round6 で「Alloy 不向き、単体テストでカバー」と留保した部分を厳密証明に格上げ）。
- **TLA+** … ドラッグ＆ドロップの**状態機械**の安全性・活性を、stage/window 二重 mouseup の全インターリーブで検査。

## Z3 — `z3/viewport.smt2`

`app/lib/viewport.ts` の座標変換を実数上で検証。各性質は**否定を assert して `unsat`**（＝反例なし＝実数上の定理、`scale > 0` 前提）で証明する。

| 性質 | 結果 | 内容 |
|---|---|---|
| round-trip | unsat | `screenToWorld(worldToScreen(p)) = p` |
| centerOffset | unsat | `centerOffset(w)` 後、`worldToScreen(w)` がビューポート中心に一致 |
| ensureVisible (3a) | unsat | パン後、対象矩形が余白帯 `[pad, W-pad]` 内に厳密に収まる |
| ensureVisible (3b) | unsat | 既に収まっている場合オフセット不変（`changed=false`） |
| moveBranch index (4a) | unsat | 同一親移動の index 補正後、`at` が常に有効な挿入位置 `0..len-1` |
| moveBranch index (4b) | unsat | 直後スロットへの前方移動が no-op 位置（補正で元スロット）になる |
| sanity | sat | 非退化なモデルが存在 |

```bash
z3 formal/round7/z3/viewport.smt2   # → unsat×6, sat×1
```

Alloy との棲み分け: round6 はレイアウトの**離散的な非重複**（帯が自分のボックスと子ブロックを収める）を検証した。センタリングの**連続アフィン変換**は実数で、Z3 の `unsat` が唯一の厳密な全域証明になる（Alloy/TLC は有界探索）。

## TLA+ — `tla/DragLifecycle.tla`

`app/components/MindmapEditor.tsx` の mousedown / mousemove / **stage mouseup** / **window mouseup** ハンドラを状態機械としてモデル化。

要点は release ハンドラが2つあること:
- **stage mouseup**（キャンバス上でのリリース）… プレビューをクリアし、`moved && drop=valid` なら**コミット**。DOM のバブリング（container→window）により window リスナより**必ず先**に走る。
- **window mouseup**（キャンバス外でのリリース）… プレビューをクリアして**キャンセル。決してコミットしない**。キャンバス上リリースでも発火するが、その時点で dragState は null なので早期 return（no-op）。

### 検証したプロパティ（`MaxCommits=2`、13状態）

| 種別 | 名前 | 内容 |
|---|---|---|
| INVARIANT | `NoStuckPreview` | ドラッグ非進行中はプレビューが必ずクリア済み（stuck ゴーストなし）|
| INVARIANT | `PreviewOnlyWhileMoving` | プレビュー表示は「閾値越えの move ドラッグ中」だけ |
| INVARIANT | `TextNeverPreviews` | テキスト選択ドラッグは move プレビューを出さない |
| PROPERTY | `CommitOnlyOnValidDrop` | モデルのコミットは「moved かつ有効ドロップの move」ステップのみ（キャンセル・無効ドロップ・未移動では起きない）|
| PROPERTY | `DragTerminates` | 開始したドラッグは必ず idle へ戻る（活性、`WF_vars(Release)`）|

結果: **No error has been found**（全不変条件・時相プロパティが成立）。

### mutant が示す load-bearing 性 — `tla/DragLifecycleBug.tla`

window（キャンバス外）release が**プレビュークリアを忘れる**版に変異させると、TLC は即座に反例を発見:

```
State 2: MouseDownMove   （move ドラッグ開始）
State 3: ThresholdMove   （閾値越え → preview = "shown"）
State 4: ReleaseOff      （キャンバス外リリース。だがクリア忘れ）
  → dragMode = "none" なのに preview = "shown"  = NoStuckPreview 違反
```

実コードの window-mouseup 内 `clearMovePreview()` が、この stuck ゴーストを防ぐ load-bearing な処理であることを裏付けた（round5 の循環ガード g3、round6 の `max` と同じ構図）。

```bash
cd formal/round7/tla && ./run.sh   # 良い版 → No error / mutant → NoStuckPreview violated
```

`-deadlock` は、コミット上限 `MaxCommits` に達して新規ドラッグが止まる有界化由来の idle をデッドロック誤検出しないためのフラグ（実バグではない）。

## 限界

- TLC は有界探索（`MaxCommits=2`、単一ポインタ）。stage が window より先に走る DOM バブリング順は前提として符号化している（キャンバス上リリースを1つの原子ステップ `ReleaseOver` とした）。マルチタッチ・並行ポインタは対象外。
- Z3 の実数モデルは浮動小数の丸めを抽象化（実数で厳密）。実装は `number`(float64) だが、対象は符号・スケール・オフセットの代数的正しさで、丸め誤差は別問題。
