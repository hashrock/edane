# Round 5 — `moveBranch`（ノードD&D移動）の木構造保存を Alloy で検証

ドラッグ＆ドロップでノードを移動する `moveBranch(model, nodeId, newParentId, index?)`
（`app/domain/model.ts`）が、**整形式ツリーを整形式ツリーのまま保つ**ことを
Alloy 6 で有界モデル検査した記録。

## 検証した契約

ドメイン層は `findNode` / `findParentAndIndex` が「一意なノード／親」を返すことを
前提に、モデルが常に**ID一意の木**であることに依存している。よって `moveBranch` の
安全契約は次の一文に集約される:

> 整形式ツリーに `moveBranch` の辺の張り替え（detach + 新しい親へ挿入）を適用すると、
> 結果もまた整形式ツリーである。

`moveApply[n, p]` を「コードがガード g1–g4 を通過して実際に移動する場合」の辺書き換え
（`childrenP = (children − (旧親→n)) + (p→n)`）としてモデル化し、木の不変条件を検査した。

## 実行

```bash
cd formal/round5/alloy
# 21MB の solver jar が無ければ Maven Central から取得（round4 のものを流用可）
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
ALLOY_JAR=alloy.jar ./run.sh
```

macOS で Java が無い場合は `brew install openjdk` 後、
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`。

## 結果（scope 7 = 最大7ノード）

| コマンド | 種別 | 結果 | 意味 |
|---|---|---|---|
| `MovePreservesTree` | check | **UNSAT（反例なし）** | 単一親・非循環・ID一意・連結・根に親なし、を全て保存 ✓ |
| `MoveIsPossible` | run | SATISFIABLE | 移動シナリオが実在（checkが空虚に真ではない） ✓ |
| `MoveLosesNoNode` | check | **UNSAT（反例なし）** | 移動でノードの喪失・重複が起きない（部分木が丸ごと残る） ✓ |
| `MoveReparents` | check | **UNSAT（反例なし）** | 移動ノードは新しい親の子になり、旧親からは外れる ✓ |
| `CycleWithoutG3` | run | SATISFIABLE | ガード g3 を外すと循環が生じる（下記） |

`check` が UNSAT = 反例が見つからない = その scope 内で性質が成り立つ。

## ガード g3 が load-bearing であることの反例

`moveApplyNoG3`（ガード g3 =「新しい親が移動ノードの子孫であってはならない」を除去）
では、Alloy が直ちに循環を発見した:

```
children:  N3→N1, N1→N2, N0→N3        （N0=根）
childrenP: N1→N2, N2→N3, N3→N1        ← N1→N2→N3→N1 の循環
```

`N1` を自身の子孫 `N2` の下に落とすと親子関係が輪になる。実コードの
`if (findNode(node, newParentId)) return model;`（`model.ts`）が、まさにこの循環を
防いでいる。Alloy はガードを外した途端に破綻が生じることを示し、ガードの必要性を
裏付けた。

## モデルの前提と限界

- **順序（index）は抽象化**。Alloy モデルは親子の**集合**のみを扱い、兄弟の並び順や
  挿入 index は表現しない。よって同一親内の並べ替え（reorder）は構造上 no-op として
  `parent[n] != p` で除外している。index 補正ロジック（`removedIndex < index` の −1）は
  `app/domain/model.test.ts` の単体テストで検証済み。
- **ID一意性の保存**は「移動でIDを変えない（`nid = nid`）」+「元が一意」から従う。
  `moveBranch` は新IDを生成しない（`cloneWithNewIds` を使うペーストと異なる）ため妥当。
- scope 7 は小さいが、木の不変条件の破れは通常小さな反例で現れる（small scope 仮説）。
  g3 反例は4ノードで出た。
