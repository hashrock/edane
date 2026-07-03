/*
 * Alloy formalization of edane's MindMapModel structure.
 *
 * Sources being formalized
 * ------------------------
 * DECLARED spec (documentation / comments):
 *   - README: "Tree node model (stored as JSON)".
 *   - app/domain/model.ts MindMapModel: a node has `id`, `text`, `children`.
 *   - The whole domain layer assumes a TREE keyed by unique id:
 *       findNode()           -> returns the (implicitly unique) node with an id
 *       findParentAndIndex() -> returns the (unique) parent + position
 *       cloneWithNewIds()    -> exists solely to keep ids unique when pasting
 *
 * CODE spec (what parseContent actually enforces):
 *   - app/application/persistence.ts parseContent():
 *       accepts external JSON if `typeof id === "string"` AND
 *       `typeof text === "string"` AND `Array.isArray(children)`.
 *       It performs NO check of uniqueness, single-parent, acyclicity, or that
 *       the value is even a tree. Note content originates from the DB and the
 *       PUT /api/notes/:id endpoint, i.e. from data the client can shape.
 *
 * We model the CODE contract (a `Loaded` graph that only satisfies the shape
 * checks) and the DECLARED contract (`WellFormedTree`), then ask Alloy to find
 * a graph the code accepts but that is NOT a well-formed tree, and to show how
 * removeNode/findNode misbehave on it.
 */

sig Id {}                          -- node identifiers (the string `id`)

sig Node {
  nid      : one Id,               -- this node's id
  children : set Node              -- ordered in code; order is irrelevant here
}

one sig Root in Node {}            -- parseContent returns a single top value

// ---- CODE contract: exactly what parseContent guarantees --------------------
// Every reachable value has an id (string) and a children array. That's all.
pred CodeAccepts {
  // everything is reachable from the returned Root (it's the parsed value graph)
  Node = Root.*children
}

// ---- DECLARED contract: a well-formed tree keyed by unique id ---------------
pred WellFormedTree {
  // (1) single parent: no node is a child of two different nodes
  all n : Node | lone parent[n]
  // (2) acyclic: no node reaches itself through children
  no n : Node | n in n.^children
  // (3) unique ids: the id -> node mapping is injective
  all disj a, b : Node | a.nid != b.nid
  // (4) connected under a single root
  Node = Root.*children
  // (5) the root has no parent
  no parent[Root]
}

fun parent[n : Node] : set Node { children.n }

// ---------------------------------------------------------------------------
// CHECK 1: does the code's shape contract imply a well-formed tree?
// If Alloy finds an instance -> the declared "it's a tree keyed by unique id"
// invariant is NOT enforced by parseContent.
// ---------------------------------------------------------------------------
run CodeAcceptsButNotTree {
  CodeAccepts
  not WellFormedTree
} for 4

// ---------------------------------------------------------------------------
// CHECK 2 (the concrete hazard): a graph the code accepts in which TWO
// distinct nodes share one id. findNode(id) returns only the first; a delete
// keyed by that id leaves a second live node with the same id behind.
// ---------------------------------------------------------------------------
pred DuplicateIdHazard {
  CodeAccepts
  // shape checks pass but two different nodes carry the same id
  some disj a, b : Node | a.nid = b.nid
  // and it can even be an otherwise perfectly "tree-shaped" acyclic structure
  no n : Node | n in n.^children
  all n : Node | lone parent[n]
}
run DuplicateIdHazard for 4

// ---------------------------------------------------------------------------
// CHECK 3 (aliasing / shared child = a DAG, not a tree): one node is a child
// of two parents. JSON can't express sharing, BUT duplicate ids let two array
// slots denote "the same" logical node to a human/exporter, and findParentAnd-
// Index returns only one parent -> the other edge is silently dropped on edit.
// ---------------------------------------------------------------------------
run SharedChild {
  CodeAccepts
  some n : Node | #parent[n] > 1
} for 4

// ---------------------------------------------------------------------------
// Sanity: well-formed trees DO exist within scope (the spec is satisfiable).
// ---------------------------------------------------------------------------
run WellFormedTreeExists {
  WellFormedTree
} for 4
