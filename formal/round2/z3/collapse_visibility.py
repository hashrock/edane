#!/usr/bin/env python3
"""
Round 2 / Finding B — Z3 check of the "an outline edit keeps its content
visible" invariant for the two structural edits that reparent a node under an
existing sibling: Backspace-at-start (merge into previous sibling) and Tab
(indent under previous sibling).

Sources being formalized
------------------------
DECLARED spec (the outliner contract + the codebase's own visibility rule):
  - app/domain/model.ts getFlatOrder(): descendants of a collapsed node are
    skipped "so keyboard navigation never lands on a hidden node". Visibility of
    a node = no collapsed ancestor. The flat order is what every navigation
    action and the caret walk over.
  - The app already treats "keep the just-touched content visible" as a rule
    it must uphold on insertion:
        editorReducer.ts addChild  : toggleCollapse(model, id, false) then append
        editorReducer.ts pasteBranch: toggleCollapse(model, id, false) then append
    i.e. before putting new content under a target, they EXPAND the target.
  - app/domain/model.ts mergeSuccessorInto() (Delete-at-end) guards the child
    pull-up with `!node.collapsed` — it refuses to reach INTO a collapsed node.
  So the declared/observed invariant is:
        (V)  a structural edit never leaves content the user just
             joined/indented hidden inside a collapsed node.

CODE spec (what Backspace-merge and indent actually do):
  - app/domain/model.ts mergeIntoPredecessor(): when the node has a previous
    sibling P it does `P.children.push(...node.children)` with NO check of
    P.collapsed. If P is collapsed, node's children become hidden.
  - app/domain/model.ts indentNode(): `prevSibling.children.push(node)` with NO
    check of prevSibling.collapsed. If it is collapsed, the moved node — which
    is the ACTIVE node — becomes hidden while still `activeNodeId`.
  Neither expands the target first, unlike addChild/pasteBranch.

Model: the post-edit structure. `Target` is the previous sibling the content was
moved under; `Moved` are the nodes that were just relocated to be Target's
children (they were visible before the edit). Visibility after the edit is
`not collapsed(Target)` (Target itself is visible — it stays a sibling of where
the node was). We check (V): all Moved stay visible.

Run:  python3 formal/round2/z3/collapse_visibility.py
"""

from z3 import Bool, Bool, Solver, sat, Not, And, Or, Implies

print("=" * 72)
print("Finding B — Backspace-merge / indent onto a COLLAPSED sibling hides content")
print("=" * 72)

# A minimal but faithful post-edit model.
collapsedTarget = Bool("collapsedTarget")   # previous sibling is collapsed?
targetExpandedFirst = Bool("targetExpandedFirst")  # did the op call toggleCollapse(false)?
movedVisible = Bool("movedVisible")          # is the just-moved content visible after?

s = Solver()

# Visibility rule (declared): moved content sits under Target; it is visible iff
# Target is not collapsed OR the op expanded Target first (as paste/addChild do).
s.add(movedVisible == Or(Not(collapsedTarget), targetExpandedFirst))

# CODE spec of Backspace-merge (mergeIntoPredecessor) and indent (indentNode):
# they never expand the target.
s.add(targetExpandedFirst == False)

# The precondition that makes the hazard reachable: the user has a collapsed
# previous sibling (a very common outline shape — a folded section above).
s.add(collapsedTarget == True)

# DECLARED invariant (V): the edit keeps the moved content visible.
print("\n(A) Backspace-merge / indent: does the edit preserve visibility (V)?")
s.push()
s.add(Not(movedVisible))   # look for a violation of (V)
if s.check() == sat:
    print("  SAT — VIOLATION of (V):")
    print("    previous sibling collapsed : yes")
    print("    op expands target first    : no  (mergeIntoPredecessor / indentNode)")
    print("    moved content visible after: NO  -> silently hidden")
    print("    Domain reading: joining a line onto a folded section above, or")
    print("    indenting under it, makes the joined text / the active node vanish")
    print("    from the canvas and from keyboard navigation.")
else:
    print("  UNSAT — visibility always preserved.")
s.pop()

# CONTROL: the insertion ops that DO expand first (addChild / pasteBranch).
print("\n(B) Control — addChild / pasteBranch expand the target first:")
c = Solver()
c.add(movedVisible == Or(Not(collapsedTarget), targetExpandedFirst))
c.add(collapsedTarget == True)
c.add(targetExpandedFirst == True)   # toggleCollapse(model, id, false)
c.add(Not(movedVisible))             # try to hide content
print("  can content be hidden? ", "SAT (yes)" if c.check() == sat else "UNSAT (no — always visible) ✓")
print("\n  => The app already knows to expand-before-insert (B); Backspace-merge")
print("     and indent (A) simply don't, so they inherit the hazard.")
