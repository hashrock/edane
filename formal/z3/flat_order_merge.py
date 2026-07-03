#!/usr/bin/env python3
"""
Z3 formalization of edane's flat-order navigation + backspace-at-start merge.

Sources being formalized
------------------------
DECLARED spec (documentation / code comments):
  - app/domain/model.ts  getFlatOrder():
      "DFS order of node IDs (navigation order)."
  - app/application/editorReducer.ts  backspaceAtStart:
      a non-empty node's text is merged into the PREVIOUS node in flat order
      (order[idx-1]) and the node itself is removed.
  - Outliner mental model (README): "backspace at the start of a line joins it
    with the previous line" — content/caret stay next to adjacent content.

CODE spec (what the implementation actually computes):
  - merge target M = getFlatOrder(model)[indexOf(active) - 1], where
    getFlatOrder is a PRE-ORDER DFS over the whole (expanded) tree.
  - removeNode(active) then PROMOTES active's children to active's parent.

Property under test (P) — the domain-intuitive invariant a user assumes:

    The merge target M of node X is structurally adjacent to X:
        M == parent(X)   OR   parent(M) == parent(X)   (M is a sibling of X)

If P holds for every well-formed tree, backspace never scatters content across
unrelated branches. We ask Z3 to FIND a well-formed tree that violates P.

Run:  python3 formal/z3/flat_order_merge.py
"""

from z3 import (
    Array, IntSort, Select, And, Or, Not, Implies, Solver, sat, IntVal,
)

N = 6                      # bounded scope: up to 6 nodes
ROOT = 0                   # WLOG the root is node 0 (symmetry breaking)
NODES = list(range(N))

par = Array("par", IntSort(), IntSort())   # parent index; root's parent = -1
pos = Array("pos", IntSort(), IntSort())   # sibling position (order among siblings)
dep = Array("dep", IntSort(), IntSort())   # depth (root = 0); forces acyclicity

s = Solver()

# --- Well-formed tree constraints (the DECLARED "it is a tree" contract) ---
s.add(Select(par, IntVal(-1)) == -1)       # sentinel: ancestor chains stop at -1
s.add(Select(par, IntVal(ROOT)) == -1)
s.add(Select(dep, IntVal(ROOT)) == 0)
s.add(Select(pos, IntVal(ROOT)) == 0)

for i in NODES:
    if i == ROOT:
        continue
    pi = Select(par, IntVal(i))
    s.add(pi >= 0, pi < N, pi != i)                       # valid, non-self parent
    s.add(Select(dep, IntVal(i)) == Select(dep, pi) + 1)  # depth decreases to root
    s.add(Select(dep, IntVal(i)) >= 1, Select(dep, IntVal(i)) <= N - 1)
    s.add(Select(pos, IntVal(i)) >= 0, Select(pos, IntVal(i)) < N)

for i in NODES:                                            # siblings ordered distinctly
    for j in NODES:
        if i < j and i != ROOT and j != ROOT:
            s.add(Implies(Select(par, IntVal(i)) == Select(par, IntVal(j)),
                          Select(pos, IntVal(i)) != Select(pos, IntVal(j))))


def anc(a, d):
    """Z3 Bool: concrete node `a` is a proper ancestor of concrete node `d`."""
    chain, terms = IntVal(d), []
    for _ in range(N - 1):
        chain = Select(par, chain)        # climb one level toward the root
        terms.append(chain == a)
    return Or(*terms)


def before(m, x):
    """Z3 Bool: node m precedes node x in pre-order DFS (getFlatOrder), fully
    expanded. m before x iff m is an ancestor of x, or at their divergence
    point m's covering branch has an earlier sibling position."""
    if m == x:
        return Or()                        # false
    div = []
    for cu in NODES:
        for cv in NODES:
            if cu == cv:
                continue
            # cu covers m: cu == m, or cu is an ancestor of m
            cu_cov = anc(IntVal(cu), IntVal(m)) if cu != m else And(True)
            cv_cov = anc(IntVal(cv), IntVal(x)) if cv != x else And(True)
            div.append(And(
                cu_cov, cv_cov,
                Select(par, IntVal(cu)) == Select(par, IntVal(cv)),
                Select(pos, IntVal(cu)) < Select(pos, IntVal(cv)),
            ))
    return Or(anc(IntVal(m), IntVal(x)), Or(*div))


# --- Counterexample search --------------------------------------------------
# Some non-root x whose immediate DFS-predecessor m is neither x's parent nor a
# sibling of x (i.e. backspace splices X's text into an unrelated subtree).
disjuncts = []
for x in NODES:
    if x == ROOT:
        continue
    for m in NODES:
        if m == x:
            continue
        m_before_x = before(m, x)
        no_between = And(*[
            Not(And(before(m, z), before(z, x)))
            for z in NODES if z != m and z != x
        ])
        not_parent = Select(par, IntVal(x)) != IntVal(m)
        not_sibling = Select(par, IntVal(m)) != Select(par, IntVal(x))
        disjuncts.append(And(m_before_x, no_between, not_parent, not_sibling))

s.add(Or(*disjuncts))

print("=" * 70)
print("Z3 model check: getFlatOrder + backspaceAtStart merge target")
print("Property P: merge target is X's parent OR a sibling of X")
print("=" * 70)

if s.check() != sat:
    print("\nUNSAT — no counterexample within scope (property holds).")
    raise SystemExit

mdl = s.model()
pv = {i: mdl.eval(Select(par, IntVal(i))).as_long() for i in NODES}
pv[-1] = -1
ps = {i: mdl.eval(Select(pos, IntVal(i))).as_long() for i in NODES}
letters = "ABCDEFGH"
label = lambda i: "Root" if i == ROOT else letters[i]
children = lambda p: sorted([i for i in NODES if pv[i] == p], key=lambda i: ps[i])

flat = []
def walk(n):
    flat.append(n)
    for c in children(n):
        walk(c)
walk(ROOT)

hit = None
for x in NODES:
    if x == ROOT:
        continue
    idx = flat.index(x)
    if idx == 0:
        continue
    m = flat[idx - 1]
    if pv[x] != m and pv[m] != pv[x]:
        hit = (x, m)
        break

print("\nSAT — counterexample tree found:\n")
def draw(n, d=0):
    print("  " * d + label(n))
    for c in children(n):
        draw(c, d + 1)
draw(ROOT)
print("\nflat (DFS navigation) order:", " -> ".join(label(i) for i in flat))
if hit:
    x, m = hit
    print(f"\nBackspace at start of node '{label(x)}':")
    print(f"  immediate flat-order predecessor = merge target M = '{label(m)}'")
    print(f"  parent(X={label(x)}) = {label(pv[x])}")
    print(f"  parent(M={label(m)}) = {label(pv[m])}")
    print("  => M is NOT the parent of X, and NOT a sibling of X.")
    print(f"  => X's text is spliced into '{label(m)}' (a different subtree),")
    print(f"     while X's children are promoted up to '{label(pv[x])}'.")
    print("\n  PROPERTY P VIOLATED: backspace scatters content across branches.")
