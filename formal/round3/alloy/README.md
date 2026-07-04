# round3 / Alloy — outline root-row navigation invariant

Formalizes the bug behind "アウトラインで一番上まで行くと移動できなくなる" and the fix
(rendering the root as the first outline row).

## The property

Keyboard navigation walks `getFlatOrder()` (`app/domain/model.ts`), which
**includes the root** and skips collapsed subtrees. The outline layout's
`outlineRows()` (`app/application/outline.ts`) used to **exclude** the root
(`depth > 0`), so the caret could move to a node (the root) that had no visible
row — the overlay editor unmounts and navigation sticks at the top.

`OutlineRootRow.als` models the navigable set (`navSet`) and the visible rows
under the old rule (`rowsOld`, root excluded) and the new rule (`rowsNew`, root
included), then asks whether the rows cover the navigable nodes.

## Commands & expected verdicts

| command | kind | expected | meaning |
|---|---|---|---|
| `RootNavigableButHasNoRow` | run | **SAT** | the old rule leaves the root navigable but rowless — the bug |
| `RowsCoverNavigation` | check | **UNSAT (no counterexample)** | the new rule's rows cover every navigable node — bug class removed |
| `Example` | run | **SAT** | sanity: a tree with a collapsed subtree still has a root row |

## Run

```sh
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
ALLOY_JAR=alloy.jar ./run.sh
```

Requires a Java runtime (`java`/`javac`). The 21 MB solver jar is git-ignored.
