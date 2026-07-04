/*
 * Alloy formalization of edane's moveBranch() drag & drop node move.
 *
 * Source being formalized
 * -----------------------
 * app/domain/model.ts moveBranch(model, nodeId, newParentId, index?):
 *   Guards (return the SAME model = no structural change):
 *     (g1) model.id === nodeId            -> the root cannot move
 *     (g2) nodeId === newParentId         -> cannot drop a node on itself
 *     (g3) findNode(node, newParentId)    -> newParent is inside the moved
 *                                            subtree (its descendant, incl.
 *                                            itself) => cycle guard
 *     (g4) newParent / node not found     -> unknown ids
 *     (g5) no-op position                 -> lands exactly where it already is
 *   Otherwise (the "apply" case):
 *     - splice the node out of its current parentPs children
 *     - insert the (whole) subtree under newParent
 *
 * What we verify
 * --------------
 * The domain layer everywhere assumes the model stays a WELL-FORMED TREE keyed
 * by unique id (findNode / findParentAndIndex return a UNIQUE node/parent). So
 * the safety contract for moveBranch is:
 *
 *   applying moveBranch to a well-formed tree yields a well-formed tree.
 *
 * We model the pre-state tree (`children`) and the post-state tree (`childrenP`)
 * as the exact edge rewrite the code performs, restricted to the case where the
 * guards g1–g4 PASS (an actual move happens), and check that every tree
 * invariant is preserved: single parent, acyclicity, connectivity, unique ids,
 * root has no parent, and no node is lost or duplicated.
 *
 * The interesting one is acyclicity: it is preserved ONLY because of guard g3
 * (newParent must not be the moved node or one of its descendants). We also run
 * a mutant WITHOUT g3 and expect Alloy to find a cycle counterexample, proving
 * the guard is load-bearing.
 */

sig Id {}

sig Node {
  nid       : one Id,          -- this node's string id (unique in a good tree)
  children  : set Node,        -- pre-state child edges
  childrenP : set Node         -- post-state child edges (after moveBranch)
}

one sig Root in Node {}

fun parent   [n : Node] : set Node { children.n }
fun parentP  [n : Node] : set Node { childrenP.n }

// ---- A well-formed tree over a given child relation -------------------------
pred wellFormed [ch : Node->Node] {
  all n : Node | lone ch.n                 -- single parent
  no n : Node | n in n.^ch                 -- acyclic
  all disj a, b : Node | a.nid != b.nid    -- unique ids
  Node = Root.*ch                          -- connected under the one root
  no Root.~ch                              -- root has no parent
}

// ============================================================================
// The moveBranch edge rewrite (the "apply" case: guards g1–g4 pass).
// Move node `n` under new parent `p`.
// ============================================================================
pred moveApply [n, p : Node] {
  // --- Precondition: a well-formed tree to start from
  wellFormed[children]

  // --- Guards that must PASS for a real move (g1,g2,g3,g4):
  n != Root                    -- g1: root cannot be moved
  n != p                       -- g2: not onto itself
  p not in n.^children         -- g3: new parent is not a descendant of n
                               --     (n != p already covers "not itself")
  // g4 (ids exist) is implicit: n and p are Nodes in scope.
  // A real reparent changes the node's parent. A same-parent move only
  // reorders siblings (an index change we don't model), leaving the tree
  // structure identical — so we scope to the structurally meaningful case.
  parent[n] != p

  // --- The edge rewrite the code performs:
  // n is detached from its current parent and attached under p; every other
  // parent->child edge is unchanged. Expressed as: post edges = pre edges,
  // minus (oldParent -> n), plus (p -> n).
  let op = parent[n] |
    childrenP = (children - (op -> n)) + (p -> n)

  // ids never change on a move
  nid = nid
}

// ============================================================================
// CHECK A — the safety contract: moveBranch preserves a well-formed tree.
// Alloy searches for a counterexample (a move that breaks some invariant).
// Expect: UNSAT (no counterexample) = the contract holds within scope.
// ============================================================================
check MovePreservesTree {
  all n, p : Node | moveApply[n, p] => wellFormed[childrenP]
} for 7

// Sanity: the "apply" scenario is actually reachable (guards can pass on a
// real tree with >1 node), so CHECK A isn't vacuously true.
run MoveIsPossible {
  some n, p : Node | moveApply[n, p] and childrenP != children
} for 7

// ============================================================================
// CHECK B — no node is lost or duplicated by the move: the post-state reaches
// exactly the same set of nodes as the pre-state (the moved subtree survives).
// Expect: UNSAT (no counterexample).
// ============================================================================
check MoveLosesNoNode {
  all n, p : Node |
    moveApply[n, p] => (Root.*childrenP = Root.*children)
} for 7

// ============================================================================
// CHECK C — the moved node really ends up as a child of the new parent, and no
// longer under its old parent. Expect: UNSAT (no counterexample).
// ============================================================================
check MoveReparents {
  all n, p : Node |
    moveApply[n, p] => (n in p.childrenP and n not in parent[n].childrenP)
} for 7

// ============================================================================
// MUTANT — drop guard g3 (allow p to be a descendant of n). Now a move can put
// a node under its own descendant, which must create a cycle. Alloy should find
// that cycle: SATISFIABLE = the counterexample the guard exists to prevent.
// ============================================================================
pred moveApplyNoG3 [n, p : Node] {
  wellFormed[children]
  n != Root
  n != p
  // g3 intentionally REMOVED
  let op = parent[n] |
    childrenP = (children - (op -> n)) + (p -> n)
  nid = nid
}

run CycleWithoutG3 {
  some n, p : Node |
    moveApplyNoG3[n, p] and (some x : Node | x in x.^childrenP)
} for 7
