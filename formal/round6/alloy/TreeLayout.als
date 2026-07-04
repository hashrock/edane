/*
 * Alloy formalization of edane's tree-layout vertical size calculation.
 *
 * Source being formalized
 * -----------------------
 * app/lib/treeLayout.ts calculateNodeSizes() / calculateSubtreeHeight():
 *
 *   slotHeight(n)      = max(NODE_MIN_HEIGHT, measuredHeight)         // "own" box
 *   subtreeHeight(n)   = leaf ? slotHeight(n)
 *                             : max( slotHeight(n),                    // <- the max
 *                                    sum(child subtreeHeight) + (childCount-1)*VGAP )
 *
 * assignNodePositions() then reserves each node a VERTICAL BAND of height
 * subtreeHeight, stacks the children consecutively inside that band (currentY +=
 * childSubtreeHeight + VGAP) and centres the node's own box on the band.
 *
 * What we verify
 * --------------
 * The layout is overlap-free iff every node's reserved band is large enough to
 * hold BOTH its own box AND the consecutive block of its children. That is the
 * pair of invariants:
 *
 *   (I1)  subtreeHeight(n) >= slotHeight(n)                 -- own box fits
 *   (I2)  subtreeHeight(n) >= childrenBlock(n)              -- children fit
 *          where childrenBlock(n) = sum(child subtreeHeight) + (childCount-1)*VGAP
 *
 * Given I1 and I2, the positional packing places the children in disjoint
 * consecutive sub-intervals of the band (total length childrenBlock <= band) and
 * the own box within the band, so by induction no two node boxes overlap. I1/I2
 * are exactly what the `max(own, childrenBlock)` in subtreeHeight guarantees.
 *
 * CHECK A proves the recurrence establishes I1 & I2 for every node.
 * The MUTANT drops the `max` (subtreeHeight = childrenBlock, ignoring own). A
 * tall parent whose own box exceeds its children block then gets a band SHORTER
 * than its own box — its box overflows into the next sibling's band. Alloy finds
 * that overflow (I1 violated), proving the `max(own, ...)` is load-bearing.
 *
 * Units: VGAP is modelled as the constant 1 (only the ratio of gaps to heights
 * matters for the fit); "own" heights are bounded small so bounded Int suffices.
 */

sig Node {
  own  : Int,        -- slotHeight(n): the node's own box height (>= min)
  kids : set Node,   -- children
  sh   : Int         -- subtreeHeight(n): the reserved band height
}

one sig Root in Node {}

// ---- Tree shape + bounded, sensible own-heights -----------------------------
fact Tree {
  all n : Node | lone kids.n         -- single parent
  no n : Node | n in n.^kids         -- acyclic
  Node = Root.*kids                  -- connected under the one root
  no Root.~kids                      -- root has no parent
  // Own height >= 1 (a real minimum slot) and bounded so bounded Int can't wrap.
  all n : Node | n.own >= 1 and n.own =< 4
}

// VGAP as a small constant (see header).
fun vgap : Int { 1 }

// childrenBlock(n) = sum(child sh) + (childCount - 1) * VGAP, for a node with
// children. With VGAP = 1 the gap term is simply (#kids - 1).
fun childrenBlock [n : Node] : Int {
  (sum c : n.kids | c.sh).plus[minus[#n.kids, 1]]
}

fun max [a, b : Int] : Int { a >= b implies a else b }

// ---- The subtreeHeight recurrence (faithful, WITH the load-bearing max) -----
// A predicate (not a fact) so the mutant below can replace it in its own run.
pred wellSized {
  all n : Node |
    (no n.kids implies n.sh = n.own)
    and
    (some n.kids implies n.sh = max[n.own, childrenBlock[n]])
}

// The pair of fit invariants (see header).
pred fitInvariants {
  all n : Node {
    n.sh >= n.own                                    -- (I1) own box fits
    some n.kids implies n.sh >= childrenBlock[n]      -- (I2) children fit
  }
}

// ============================================================================
// CHECK A — the recurrence establishes the fit invariants for every node.
// Expect: UNSAT (no counterexample) within scope.
// ============================================================================
check RecurrenceEstablishesFit {
  wellSized implies fitInvariants
} for 5 Node, 7 Int

// Sanity: non-trivial well-sized trees exist (a tall parent whose own box
// exceeds its children block), so CHECK A isn't vacuous.
run WellSizedTallParentExists {
  wellSized
  some n : Node | some n.kids and n.own > childrenBlock[n]
} for 5 Node, 7 Int

// ============================================================================
// MUTANT — subtreeHeight WITHOUT the max (band = children block, own ignored).
// A tall parent then gets sh < own: its own box overflows its reserved band and
// collides with the next sibling. Alloy should find it: SATISFIABLE.
// ============================================================================
pred wellSizedNoMax {
  all n : Node |
    (no n.kids implies n.sh = n.own)
    and
    (some n.kids implies n.sh = childrenBlock[n])
}

run OverflowWithoutMax {
  wellSizedNoMax
  some n : Node | n.sh < n.own      -- own box taller than its band => overlap
} for 5 Node, 7 Int
