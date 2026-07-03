/*
 * Round 2 / Finding B — Alloy model of the collapse-visibility hazard in the
 * two structural edits that reparent a node under its previous sibling:
 * Backspace-at-start (mergeIntoPredecessor) and Tab-indent (indentNode).
 *
 * Sources being formalized
 * ------------------------
 * DECLARED spec:
 *   - app/domain/model.ts getFlatOrder(): "descendants of a collapsed node are
 *     skipped so keyboard navigation never lands on a hidden node." Visibility
 *     of a node := it has no collapsed proper ancestor.
 *   - app/application/editorReducer.ts addChild / pasteBranch: both call
 *     toggleCollapse(model, targetId, false) BEFORE inserting, i.e. the app's
 *     own rule is "expand a target before putting content under it, so the
 *     content stays visible."
 *   - app/domain/model.ts mergeSuccessorInto (Delete-at-end) guards with
 *     `!node.collapsed` — it refuses to reach into a collapsed node.
 *   Declared invariant (V): an outline edit never leaves the content it just
 *   joined/indented hidden inside a collapsed node.
 *
 * CODE spec:
 *   - mergeIntoPredecessor(): `prevSibling.children.push(...node.children)` and
 *   - indentNode():            `prevSibling.children.push(node)`
 *   both reparent under the previous sibling with NO check of its `collapsed`
 *   flag and NO expand-first. So the post-edit tree can have just-moved content
 *   directly under a collapsed node.
 *
 * We model the POST-edit tree: `Target` is the previous sibling the content was
 * moved under, `Moved` is the content the user just relocated (visible before
 * the edit, by construction), and check (V): every Moved node is still visible.
 */

sig Node {
  children : set Node
}
sig Collapsed in Node {}          -- the subset of nodes whose descendants are hidden

one sig Root in Node {}

// Distinguished atoms of the post-edit state.
one sig Target in Node {}         -- the previous sibling the content was moved under
sig Moved in Node {}              -- nodes just relocated to be Target's children

fun parent[n : Node] : set Node { children.n }

// A well-formed tree keyed structurally (single parent, acyclic, rooted).
pred Tree {
  all n : Node | lone parent[n]
  no n : Node | n in n.^children
  Node = Root.*children
  no parent[Root]
}

// A node is visible iff none of its proper ancestors is collapsed.
pred visible[n : Node] {
  no a : Node | n in a.^children and a in Collapsed
}

// The post-edit shape produced by mergeIntoPredecessor / indentNode:
//   - the moved content is exactly Target's children,
//   - Moved is non-empty (a merge moves the node's text-bearing children /
//     indent moves the node itself),
//   - Target is a visible node (it stays a sibling where the node used to be),
//     so the ONLY thing that can hide Moved is Target being collapsed.
pred PostReparentUnderPrevSibling {
  Tree
  Moved = Target.children
  some Moved
  visible[Target]
  Root not in Target        -- the previous sibling is a real inner node
}

// ---------------------------------------------------------------------------
// CHECK: can a code-produced post-edit tree hide the just-moved content?
// An instance is a counterexample to the declared invariant (V).
// ---------------------------------------------------------------------------
run JoinHidesContent {
  PostReparentUnderPrevSibling
  Target in Collapsed          -- code did NOT expand the target
  some m : Moved | not visible[m]
} for 5

// ---------------------------------------------------------------------------
// CONTROL: the addChild / pasteBranch behaviour (expand the target first) — the
// target is NOT collapsed — can never hide the moved content. Expect UNSAT.
// ---------------------------------------------------------------------------
run ExpandFirstNeverHides {
  PostReparentUnderPrevSibling
  Target not in Collapsed      -- toggleCollapse(target, false) was applied
  some m : Moved | not visible[m]
} for 5

// ---------------------------------------------------------------------------
// Sanity: a visible-preserving reparent exists (the invariant is satisfiable).
// ---------------------------------------------------------------------------
run VisiblePreservingReparentExists {
  PostReparentUnderPrevSibling
  all m : Moved | visible[m]
} for 5
