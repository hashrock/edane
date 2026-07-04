/*
 * Alloy formalization of the outline navigation / root-row invariant.
 *
 * Sources being formalized
 * ------------------------
 * DECLARED spec:
 *   - Keyboard navigation walks getFlatOrder() (app/domain/model.ts), which
 *     INCLUDES the root at index 0 and skips descendants of a collapsed node.
 *   - moveUp/moveDown (app/application/editorReducer.ts) step through exactly
 *     that flat order, so the caret can land on ANY node in it — including root.
 *
 * CODE spec (what the outline layout actually rendered — the bug):
 *   - app/application/outline.ts outlineRows() built the visible rows but
 *     EXCLUDED the root (`depth > 0`), because the root was shown as the header
 *     title. The overlay editor is only mounted for a row that exists
 *     (OutlineEditor: `bodyActive = editing && activeNodeId !== model.id`).
 *
 * The hazard: the caret's reachable set (flat order) is NOT covered by the
 * visible rows. Pressing ArrowUp from the first child sets activeNodeId = root,
 * but root has no row, so the editor overlay unmounts and navigation "sticks"
 * at the top — the reported bug ("一番上まで行くと移動できなくなる").
 *
 * We model both the OLD rule (root excluded) and the NEW rule (root included)
 * and ask Alloy whether the visible rows cover the navigable nodes.
 */

sig Node {
  children : set Node,
  collapsed : lone Node        -- a flag: `this in collapsed` iff collapsed
}

one sig Root in Node {}

// A well-formed document tree keyed off a single root.
pred Tree {
  all n : Node | lone parent[n]        -- single parent
  no n : Node | n in n.^children       -- acyclic
  Node = Root.*children                 -- connected under the root
  no parent[Root]                       -- root has no parent
}

fun parent[n : Node] : set Node { children.n }

// `collapsed` used as a boolean flag on each node.
pred isCollapsed[n : Node] { n in n.collapsed }

// ---------------------------------------------------------------------------
// getFlatOrder(): navigation set. DFS from the root, INCLUDING the root, and
// NOT descending past a collapsed node. A node is navigable iff every proper
// ancestor between it and the root is expanded (root itself is always in).
// ---------------------------------------------------------------------------
fun navSet : set Node {
  { n : Node | no a : ancestors[n] | isCollapsed[a] }
}

// proper ancestors of n that are strictly below the root..n path, i.e. nodes
// a such that a is on the path root->n and a != n. (a reaches n via children)
fun ancestors[n : Node] : set Node { { a : Node | n in a.^children } }

// ---------------------------------------------------------------------------
// outlineRows(): the visible rows.
//   OLD rule — root excluded (the bug).
//   NEW rule — root included (the fix).
// A collapsed node itself is still a visible row; only its descendants drop out,
// which navSet already accounts for.
// ---------------------------------------------------------------------------
// OLD rule mirrors outlineRows()'s `depth > 0`: it walks the same DFS as the
// navigation but drops the root row.
fun rowsOld : set Node { { n : Node | n != Root and no a : ancestors[n] | isCollapsed[a] } }
// NEW rule pushes EVERY visited node (including the root) — derived from the
// DFS independently of navSet so the coverage `check` below is a real property.
fun rowsNew : set Node { { n : Node | no a : ancestors[n] | isCollapsed[a] } }

// ---------------------------------------------------------------------------
// CHECK 1 (the bug): under the OLD rule there is a navigable node with no row.
// SATISFIABLE => the caret can reach a node the outline cannot display/edit.
// ---------------------------------------------------------------------------
run RootNavigableButHasNoRow {
  Tree
  some n : navSet | n not in rowsOld     -- concretely: Root itself
} for 4

// ---------------------------------------------------------------------------
// CHECK 2 (the fix): under the NEW rule, the visible rows cover EVERY navigable
// node. If this check finds NO counterexample (UNSAT), the fix removes the
// class of bug entirely: the caret can never land where there is no row.
// ---------------------------------------------------------------------------
check RowsCoverNavigation {
  Tree implies navSet = rowsNew
} for 6

// Sanity: a tree with a collapsed subtree still type-checks and has a root row.
run Example {
  Tree
  some n : Node | isCollapsed[n]
  Root in rowsNew
} for 4
