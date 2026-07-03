# edane 形式仕様・モデル検査 — 第2ラウンド（修正後コードの再検査）

第1ラウンド（[`../`](../)）で見つかった4件は修正済み。本ラウンドは**その修正後の
コード**に対して、ドキュメント／コードコメントが**宣言している仕様**と、コードが
**実際に計算している仕様**を改めて Z3・Alloy・TLA+ で形式化し、モデル検査で新たな
食い違い（反例）を機械的に探索した記録。

- 反例をドメイン用語で説明したもの → [`FINDINGS.md`](./FINDINGS.md)（**新規2件**）
- ドメインエキスパート向けビジュアル報告 → [`report.html`](./report.html)（ブラウザで開く）
- 実コードでの再現テスト → [`repro/round2.test.ts`](./repro/round2.test.ts)（5件パス）

## 新しく見つかった綻び（要約）

| # | 宣言仕様 | コードの実際 | ツール | 重要度 |
|---|---|---|---|---|
| A | ビューは常にアクティブなノードを忠実に映す | Undoは本文だけ復元・`reconcileView`は「存在」しか直さず、編集バッファ／カーソルが古いまま残り、次の入力でUndoが帳消しになる | Z3・TLA+ | 高 |
| B | 構造編集は連結・インデントした内容を折りたたみの中に隠さない | Backspace連結（`mergeIntoPredecessor`）とTabインデント（`indentNode`）が折りたたみを無視して突っ込み、本文や選択中ノードが不可視化される | Z3・Alloy | 中〜高 |

いずれも「第1ラウンドの修正が、**より弱い不変条件までしか締めていなかった**」ために
残った綻び：
- 所見A：所見3の修正は「アクティブは*存在*する」を強制したが、「ビューがアクティブを*忠実に映す*」は未強制。
- 所見B：所見1の修正で連結は構造的な前ノードへ向くようになったが、その前ノードが*折りたたまれている*場合の可視性は未考慮。

## 構成

```
formal/round2/
├── FINDINGS.md                 ← ドメインエキスパート向け説明（反例と影響）
├── report.html                 ← 同・ビジュアル版（ブラウザ）
├── z3/
│   ├── view_faithfulness.py    ← 所見A: 「ビューはアクティブを忠実に映す」の綻び
│   └── collapse_visibility.py  ← 所見B: 「連結・インデントは内容を隠さない」の綻び
├── alloy/
│   ├── CollapseVisibility.als  ← 所見B: 折りたたみ可視性の構造反例
│   ├── RunAlloy.java           ← Alloyをヘッドレス実行するドライバ（公開API）
│   └── run.sh
├── tla/
│   ├── EditUndo.tla            ← 所見A: 編集＋Undoの状態機械／不変条件 ViewFaithful
│   └── EditUndo.cfg
└── repro/
    ├── round2.test.ts          ← 反例を実コードで再現（characterizationテスト）
    └── vitest.config.ts
```

## 実行方法

### Z3（Python）— 実行済み・反例あり
```bash
pip install z3-solver
python3 formal/round2/z3/view_faithfulness.py    # 所見A: SAT（バッファ/カーソルが古い状態）
python3 formal/round2/z3/collapse_visibility.py  # 所見B: SAT（折りたたみ下に内容が隠れる）+ 対照UNSAT
```

### Alloy 6（Maven Central から取得。GitHub不要）— 実行済み
```bash
cd formal/round2/alloy
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
./run.sh
# JoinHidesContent            -> SATISFIABLE（折りたたみ対象の直下に不可視の内容）
# ExpandFirstNeverHides       -> UNSAT       （開いてから入れる＝addChild/paste は隠せない）
# VisiblePreservingReparentExists -> SATISFIABLE（サニティ）
```

### TLA+（TLC）— 仕様のみ（この環境ではTLC未実行）
```bash
cd formal/round2/tla
# tla2tools.jar を用意（TLA+ Toolbox 同梱など）
tlc EditUndo.tla -config EditUndo.cfg
# ReconcileRefreshesBuffer=FALSE で INVARIANT ViewFaithful が VIOLATED（Init→Edit→Undo の短トレース）
# .cfg で TRUE にすると不変条件は保たれる（＝修正案の確認）
```

> **TLCの実行環境について**: 本サンドボックスの外向き通信は PyPI / npm / Maven Central に
> 限られ、`tla2tools.jar` の配布元（GitHub Releases 等）へ到達できないためTLCは未実行。
> TLA+ 仕様が主張する不変条件 `ViewFaithful` は、同一の反例を **Z3（`view_faithfulness.py`、
> 実行可能）** と **実コードの再現テスト** でクロスチェック済み。仕様自体は標準構文で、上記
> コマンドでそのまま検査できる。

### 実コードでの再現テスト
```bash
npx vitest run --config formal/round2/repro/vitest.config.ts   # 5 tests pass
```
（本体の `pnpm test` には影響しない独立設定。修正が入ると失敗に転じ、修正の効き目を検知する。）

## 検査した性質のサマリ

| 性質 | ツール | 結果 |
|---|---|---|
| Undo後もビューはアクティブなノードを忠実に映す（表示＝本文・カーソル範囲内） | Z3 / TLA+ | **反例あり**（所見A） |
| Backspace連結・Tabインデントは移した内容を可視に保つ | Z3 / Alloy | **反例あり**（所見B） |
| 「開いてから入れる」経路（addChild/paste）は内容を隠さない | Z3 / Alloy | 反例なし（対照・健全） |
| reconcileがバッファも採り直せば ViewFaithful は保たれる | Z3 / TLA+ | 反例なし（修正案の確認） |
| 可視性を保つ連結は存在する（宣言仕様は充足可能） | Alloy | 充足（サニティ） |
```
