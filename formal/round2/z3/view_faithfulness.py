#!/usr/bin/env python3
"""
Round 2 / Finding A — Z3 bounded check of the "editor view faithfully mirrors
the active node" invariant across the undo/redo (`replace`) path.

Context
-------
Round 1 (formal/FINDINGS.md, finding 3) showed that after undo the selection
could dangle at a node absent from the restored document. The fix folded
`reconcileView()` into the reducer's `replace` branch, so the WEAK invariant
   (I0)  the active node always EXISTS in the document
is now enforced by the reducer itself. This model checks the STRONGER
invariant that the rest of the reducer — and the whole rendering path — quietly
assumes but that `reconcileView()` does NOT restore.

Sources being formalized
------------------------
DECLARED spec (what every non-`replace` path maintains, and what the UI reads):
  - app/application/editorReducer.ts focusView(): moving focus sets
        editingText := node.text ,  cursorPos/selectionEnd within that text.
    Every structural/navigation/text branch re-derives the view from the new
    model this way, so the reducer's own contract is:
        (I1)  view.editingText == text(active)                 [buffer mirrors model]
        (I2)  0 <= cursorPos <= len(text(active))              [caret in range]
  - app/components/MindmapEditor.tsx renders the active node from `editingText`
    (lines 1155, 1204) and drives the textarea with
        el.value = editingText ; el.setSelectionRange(cursorPos, selectionEnd)
    (lines 427-428). So the display and the caret are the view's buffer, not the
    document — (I1)/(I2) are load-bearing for what the user actually sees.

CODE spec (what reconcileView / replace actually enforce):
  - app/application/editorReducer.ts reconcileView():
        if (view.activeNodeId && findNode(model, view.activeNodeId)) return view;
    i.e. when the active node still exists the INCOMING view is returned
    UNCHANGED — editingText and cursorPos are copied verbatim from a view that
    was derived from a *different* (pre-undo) document. Only (I0) is checked.
  - app/components/MindmapEditor.tsx restoreDocument() passes
        { document: restored, view: stateRef.current.view }
    the *current* (stale) view together with the restored document.

We look for a state that satisfies the code contract (I0) but violates the
declared/render contract (I1)/(I2). SAT => the buffer/caret can be stale after
undo: the edited node is displayed with its pre-undo text and an out-of-range
caret, and (see repro) the next keystroke re-commits the stale buffer, silently
undoing the undo.

Run:  python3 formal/round2/z3/view_faithfulness.py
"""

from z3 import (
    Array, IntSort, Int, Select, Solver, sat, Or, And, IntVal,
)

print("=" * 72)
print("Finding A — 'view mirrors the active node' after undo (replace path)")
print("=" * 72)

M = 4  # node slots 0..M-1 (0 = root, always present)

present = Array("present", IntSort(), IntSort())  # 0/1
textlen = Array("textlen", IntSort(), IntSort())  # length of each node's text

active = Int("active")   # view.activeNodeId as an index
eLen = Int("eLen")       # length of view.editingText (the edit buffer)
cursor = Int("cursor")   # view.cursorPos

s = Solver()

# --- Well-typed document -----------------------------------------------------
for i in range(M):
    s.add(Or(Select(present, IntVal(i)) == 0, Select(present, IntVal(i)) == 1))
    s.add(Select(textlen, IntVal(i)) >= 0)
    s.add(Select(textlen, IntVal(i)) <= 8)
s.add(Select(present, IntVal(0)) == 1)  # root survives every edit

# --- What replace()/reconcileView() GUARANTEE about the resulting view -------
# (I0) enforced: after replace, the active node exists in the restored document.
s.add(active >= 0, active < M)
s.add(Select(present, active) == 1)

# reconcileView returns the incoming view unchanged in this branch, so eLen and
# cursor are whatever the pre-undo view held: unconstrained by the new document
# beyond being well-typed non-negative numbers.
s.add(eLen >= 0)
s.add(cursor >= 0, cursor <= eLen)  # a real textarea keeps caret within its own value

# --- The DECLARED / render invariant we are testing --------------------------
#   ViewFaithful := (I1) eLen == textlen[active]  AND
#                   (I2) cursor <= textlen[active]
# Ask for a state the code permits that ViewFaithful forbids.
declared_I1 = eLen == Select(textlen, active)
declared_I2 = cursor <= Select(textlen, active)
s.add(Or(eLen != Select(textlen, active), cursor > Select(textlen, active)))

print("\nSearching for a post-undo state where the active node exists (code's")
print("only guarantee) but the edit buffer / caret no longer match it ...\n")

if s.check() == sat:
    mdl = s.model()
    a = mdl.eval(active).as_long()
    tl = [mdl.eval(Select(textlen, IntVal(i))).as_long() for i in range(M)]
    pr = [mdl.eval(Select(present, IntVal(i))).as_long() for i in range(M)]
    e = mdl.eval(eLen).as_long()
    c = mdl.eval(cursor).as_long()
    print("SAT — counterexample view/document pair:")
    print(f"  present nodes        : {[i for i in range(M) if pr[i]]}")
    print(f"  active node          : {a}  (present ✓ — reconcileView is satisfied)")
    print(f"  text(active) length  : {tl[a]}   <- what the DOCUMENT says")
    print(f"  view.editingText len : {e}   <- what the SCREEN + textarea show")
    print(f"  view.cursorPos       : {c}")
    print()
    if e != tl[a]:
        print(f"  (I1) violated: buffer shows {e} chars, node holds {tl[a]} — stale display.")
    if c > tl[a]:
        print(f"  (I2) violated: caret at {c} > node length {tl[a]} — out-of-range caret.")
    print()
    print("  Domain reading: undo restored the document, but the edited node keeps")
    print("  showing its pre-undo text with a caret past the (now shorter) text.")
    print("  reconcileView() only repairs a DANGLING active id, not a STALE buffer.")
    print("  GAP CONFIRMED.")
else:
    print("UNSAT — reconcileView already keeps the buffer/caret faithful. No gap.")

# --- Contrast: the proposed fix (reconcile refreshes the buffer too) ---------
print()
print("-" * 72)
print("Contrast: if reconcileView re-derived eLen/cursor from the active node")
print("(eLen := textlen[active]; cursor := min(cursor, textlen[active])), the")
print("same search is UNSAT:")
s2 = Solver()
for i in range(M):
    s2.add(Or(Select(present, IntVal(i)) == 0, Select(present, IntVal(i)) == 1))
    s2.add(Select(textlen, IntVal(i)) >= 0, Select(textlen, IntVal(i)) <= 8)
s2.add(Select(present, IntVal(0)) == 1)
s2.add(active >= 0, active < M, Select(present, active) == 1)
# fix: buffer + caret re-derived from the restored active node
s2.add(eLen == Select(textlen, active))
s2.add(cursor >= 0, cursor <= Select(textlen, active))
# try to break ViewFaithful under the fix
s2.add(Or(eLen != Select(textlen, active), cursor > Select(textlen, active)))
print("  result:", "SAT (still broken)" if s2.check() == sat else "UNSAT (invariant holds) ✓")
