# round4 / Alloy — note lifecycle (list ⇄ trash, pin, purge)

Formalizes the note model after the trash + pin features: `pinned` and
`deletedAt` on the `notes` table, the `/notes` and `/trash` queries, and the
trash / restore / pin / permanent-delete routes (`app/server.ts`).

`NoteLifecycle.als` models a world `State` (which notes exist, are trashed, are
pinned), derives the two views exactly as the SQL `WHERE` clauses do, and checks
that the four operations keep the model's invariants.

## Commands & verified verdicts

| command | kind | result | meaning |
|---|---|---|---|
| `InvPreserved` | check | **UNSAT** | trash/restore/purge/pin never break the invariant (e.g. a note both pinned and trashed) |
| `ViewsPartition` | check | **UNSAT** | list and trash always partition the notes — the list query never shows a trashed note |
| `TrashRestoreRoundTrip` | check | **UNSAT** | trash → restore returns the note to the list with no note lost or duplicated |
| `PurgeIsPermanent` | check | **UNSAT** | a permanently-deleted note is gone from both views |
| `TrashThenRestore` | run | **SAT** | sanity: the operations are satisfiable (checks aren't vacuous) |

UNSAT on a `check` = no counterexample within scope = the property holds.

## Run

```sh
curl -sSL -o alloy.jar \
  https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/6.2.0/org.alloytools.alloy.dist-6.2.0.jar
ALLOY_JAR=alloy.jar ./run.sh
```

Requires a Java runtime. The 21 MB solver jar is git-ignored.
