# edane 形式仕様・モデル検査

edane の**ドメインロジック**（純粋なツリーモデルとエディタreducer）について、
ドキュメント／コードコメントが**宣言している仕様**と、コードが**実際に計算している仕様**を
それぞれ Z3・Alloy・TLA+ で形式化し、モデル検査で両者の食い違い（反例）を機械的に探索した記録。

- 反例をドメイン用語で説明したもの → [`FINDINGS.md`](./FINDINGS.md)（**全4件 修正済み**。各所見に「修正内容」を追記）
- 修正後の正しい挙動を固定する回帰テスト → [`repro/reproduce.test.ts`](./repro/reproduce.test.ts)（5件パス。かつては反例を再現するテストだった）

> **第2ラウンド（再実施・2026-07）→ [`round2/`](./round2/)**
> 上記4件の**修正後コード**を対象に再検査し、**新たに2件**の綻びを発見（未修正）。
> ドメイン説明は [`round2/FINDINGS.md`](./round2/FINDINGS.md)、ビジュアル報告は
> [`round2/report.html`](./round2/report.html)、再現テストは
> [`round2/repro/round2.test.ts`](./round2/repro/round2.test.ts)（5件パス）。
> 所見A: Undo後にビューがアクティブなノードを忠実に映さない（Z3/TLA+）。
> 所見B: 折りたたみ直後のBackspace連結・Tabインデントで内容が不可視化（Z3/Alloy）。

> **第5ラウンド（新機能検証・2026-07）→ [`round5/`](./round5/alloy/)**
> ドラッグ＆ドロップのノード移動 `moveBranch`（`app/domain/model.ts`）を Alloy で検査。
> 今回は綻び探索ではなく**新機能の正当性証明**: 整形式ツリーに移動を適用しても木の
> 不変条件（単一親・非循環・ID一意・連結）が保たれることを scope 7 で確認（`check` 3件が
> 全てUNSAT=反例なし）。加えて循環ガード g3 を外した mutant では Alloy が即座に循環を
> 発見し、ガードが load-bearing であることを裏付けた。詳細 → [`round5/alloy/README.md`](./round5/alloy/README.md)。

> **第6ラウンド（新機能検証・2026-07）→ [`round6/`](./round6/alloy/)**
> カーソル位置のセンタリング機能のために整理した「ノード・枝のサイズ計算系」
> （`app/lib/viewport.ts` ＋ `app/lib/treeLayout.ts`）を検証。中核の構造不変条件
> ＝ `subtreeHeight` 再帰が**レイアウトの縦の重なりを防ぐ**ことを Alloy で確認
> （帯が自分のボックスと子ブロックを収める I1・I2 が全ノードで成立、check UNSAT）。
> `max(own, 子ブロック)` を外した mutant では帯からボックスがはみ出す反例を Alloy が
> 発見し、`max` が load-bearing であることを裏付けた。センタリングのアフィン変換自体は
> 数値の単体テスト（`app/lib/viewport.test.ts`, 17件）でカバー。
> 詳細 → [`round6/alloy/README.md`](./round6/alloy/README.md)。

> **第7ラウンド（Z3 + TLA+・2026-07）→ [`round7/`](./round7/)**
> round5/6（Alloy）が扱わなかった2側面を各ツールの得意分野で検証。
> **Z3**: センタリングの実数アフィン変換（`app/lib/viewport.ts`）— round-trip 恒等・
> ビューポート中心一致・可視化スクロールの帯内収束・moveBranch の index 補正を、否定を
> `unsat` にして全域証明（6定理）。round6 で「Alloy 不向き」と留保した部分を厳密化。
> **TLA+**: D&Dのポインタ状態機械（`MindmapEditor.tsx` の stage/window 二重 mouseup）—
> プレビューが stuck しない・move中のみ表示・コミットは有効ドロップ時のみ・ドラッグは
> 必ず終了、を全インターリーブで検査（No error）。window-mouseup のプレビュークリアを
> 外した mutant で NoStuckPreview 違反を検出し load-bearing 性を裏付け。
> 詳細 → [`round7/README.md`](./round7/README.md)。

## 形式化の対象（宣言仕様 ↔ コード仕様の出どころ）

| 対象 | 宣言仕様の出どころ | コード仕様の出どころ |
|---|---|---|
| ナビゲーション順とBackspace連結 | `getFlatOrder` のコメント「DFS順（ナビゲーション順）」＋アウトライナーの常識 | `editorReducer.ts` `backspaceAtStart`（`order[idx-1]` に連結）＋ `removeNode`（子を親へ昇格） |
| ツリーの健全性 | README「Tree node model」／`findNode`・`cloneWithNewIds` が前提とするID一意性 | `persistence.ts` `parseContent`（`id`/`text`/`children` の**形だけ**検査） |
| 選択とUndo/Redo | `editorReducer.ts`「常に1ノード選択・null にならない」／`undoManager.ts`「文書のみ復元」 | 型 `activeNodeId: string \| null`・各branchの `if (!activeNodeId)`・`reconcileView` |

## 構成

```
formal/
├── FINDINGS.md              ← ドメインエキスパート向け説明（反例と影響）
├── z3/
│   ├── flat_order_merge.py  ← 所見1: DFS順連結が枝をまたぐ反例をZ3が探索
│   └── undo_redo.py         ← 所見3: undo/redo代数の健全性＋選択不変条件の綻び
├── alloy/
│   ├── MindMap.als          ← 所見2: 木の健全性 vs parseContentの受理形状
│   ├── RunAlloy.java         ← Alloyをヘッドレス実行するドライバ（公開API）
│   └── run.sh
├── tla/
│   ├── MindMapUndo.tla      ← 所見3: エディタ状態機械＋選択不変条件
│   └── MindMapUndo.cfg
└── repro/
    ├── reproduce.test.ts    ← 反例を実コードで再現（characterizationテスト）
    └── vitest.config.ts
```

## 実行方法

### Z3（Python）
```bash
pip install z3-solver
python3 formal/z3/flat_order_merge.py   # 所見1: SAT（反例の木を表示）
python3 formal/z3/undo_redo.py          # 所見3: (A)健全 (B)反例状態
```

### Alloy 6（Maven Central から取得。GitHub不要）
```bash
cd formal/alloy
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
./run.sh
# 4コマンドすべて SATISFIABLE（コードが受理する非-木構造の実例を表示）
# MindMap.als をAlloy Analyzer GUIで開いても同じ結果が見られる。
```

### TLA+（TLC）
```bash
cd formal/tla
# tla2tools.jar を用意（TLA+ Toolbox 同梱、または各自の環境から）
tlc MindMapUndo.tla -config MindMapUndo.cfg
# ReconcileAuto=FALSE で INVARIANT ActiveAlwaysLive が VIOLATED（短いトレース）
# .cfg で ReconcileAuto=TRUE にすると不変条件は保たれる（＝修正案の確認）
```

> **TLC の実行環境について**: 本形式化を作成したサンドボックスは外向き通信が
> PyPI / npm / Maven Central に限られ、`tla2tools.jar` の配布元（GitHub Releases・
> Azure）へ到達できなかったため、TLCはこの環境では未実行。TLA+ 仕様が主張する
> 選択不変条件は、同一の反例を **Z3（`undo_redo.py` パートB、実行可能）** でクロス
> チェック済み。TLA+ 仕様自体は標準構文で、上記コマンドでそのまま検査できる。

### 実コードでの回帰テスト（修正後の挙動を固定）
```bash
npx vitest run --config formal/repro/vitest.config.ts   # 5 tests pass
```
（本体の `pnpm test` には影響しない独立設定）

## 検査した性質のサマリ

| 性質 | ツール | 結果 |
|---|---|---|
| Backspace連結先は親か兄弟（枝をまたがない） | Z3 | **反例あり**（所見1） |
| parseContentの受理形状 ⇒ 一意IDの木 | Alloy | **反例あり**（所見2） |
| Undo;Redo=恒等・edit後はRedo不可 | Z3 | 反例なし（健全） |
| 選択は常に生きたノードを指す | TLA+/Z3 | **反例あり**（所見3、reconcile未畳込み時） |
| 正しい木は存在する（宣言仕様は充足可能） | Alloy | 充足（サニティ） |
