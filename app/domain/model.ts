/**
 * Domain layer: pure tree model and operations.
 * No framework or rendering dependencies.
 *
 * Two shapes live here:
 *  - {@link MindMapModel} — a NODE (with its subtree). Every editable thing on
 *    the canvas / in the outline is one of these.
 *  - {@link MindMapDocument} — the DOCUMENT: an ordered forest of nodes
 *    (`roots`) plus the note title. The title is not a node; it is edited in
 *    the header and persisted as the note's own title, never as a tree entry.
 *
 * All mutations take a document and return a NEW document (or the same
 * reference when the operation is a no-op, where documented).
 */
import { closedStringSet } from "./isKeyOf";

/**
 * Node kind. `text` is the default; `image`/`link` store their URL in `text`;
 * `markdown` stores a raw Markdown blob in `text` (rendered as a source card).
 */
export type NodeType = "text" | "image" | "link" | "markdown";

/**
 * Node kind as stored in JSON. `"text"` is represented by absence so that
 * the common case adds no bytes. Use `NodeType` when you need the resolved kind.
 */
type StoredNodeType = Exclude<NodeType, "text">;

/**
 * `satisfies Record<StoredNodeType, true>` makes this exhaustive both ways:
 * adding a `NodeType` member refuses to compile here until it's declared,
 * which is what keeps {@link isStoredNodeType} (used to validate persisted
 * JSON) from silently dropping a newly-added type instead of erroring loudly
 * at the type level. {@link closedStringSet} derives both the predicate and
 * {@link STORED_NODE_TYPES} from this one set.
 */
const STORED_NODE_TYPE_SET = {
  image: true,
  link: true,
  markdown: true,
} as const satisfies Record<StoredNodeType, true>;

const { is: isStoredNodeType, values: STORED_NODE_TYPES } = closedStringSet(
  STORED_NODE_TYPE_SET
);

export { isStoredNodeType };

/**
 * The non-"text" `NodeType` members as an array, derived from
 * {@link STORED_NODE_TYPE_SET} so callers that need to enumerate them (rather
 * than just test membership via {@link isStoredNodeType}) stay in sync
 * automatically when a `NodeType` member is added, renamed, or removed.
 */
export { STORED_NODE_TYPES };

/** Every `NodeType`, the default first. */
export const NODE_TYPES: NodeType[] = ["text", ...STORED_NODE_TYPES];

/** Tree node (stored as JSON). */
export interface MindMapModel {
  id: string;
  text: string;
  children: MindMapModel[];
  /** When true, descendants are hidden in the canvas and skipped in navigation. */
  collapsed?: boolean;
  /** Node kind (absent = "text"). For image/link, `text` holds the URL. */
  type?: StoredNodeType;
  /** Font size in px for text nodes (absent = default 14). */
  fontSize?: number;
  /** Bold text (absent/false = normal weight). */
  bold?: boolean;
  /** Link nodes: fetched page title (shown instead of the raw URL). */
  linkTitle?: string;
  /** Link nodes: favicon URL (rendered before the title). */
  favicon?: string;
  /**
   * Task checkbox: absent = not a task, `false` = open, `true` = done.
   *
   * A FLAG rather than a `NodeType`, because "is a task" is orthogonal to what
   * a node holds — a link can be a task too — and because a node's kind decides
   * its edit surface (see application/editSurface.ts) while a checkbox doesn't
   * change how the node is edited at all. Which kinds show one is decided in
   * exactly one place: `supportsCheckbox` in application/nodeUtils.ts.
   */
  checked?: boolean;
  /**
   * Canvas position of this node's tree, world coordinates of the box's left
   * edge (x) and vertical centre (y) — the same point the layout assigns.
   * Only meaningful on a ROOT (see {@link MindMapDocument.roots}): a placed
   * tree stays where the user dropped it, an unplaced one is auto-stacked
   * below the others. Dropped by every operation that nests the node under
   * another (`moveBranch`, `indentNode`, …).
   */
  position?: NodePosition;
}

export interface NodePosition {
  x: number;
  y: number;
}

/**
 * The document: an ordered forest. Each root is an independent tree drawn on
 * the canvas (freely placeable, see {@link MindMapModel.position}) and listed
 * at depth 0 in the outline.
 *
 * Invariant: `roots` is never empty — there would be nothing to select and no
 * way to start typing. `parseContent` and the editor reducer restore it with
 * {@link ensureRoot} after any operation that could empty it.
 */
export interface MindMapDocument {
  /** Note title. Edited in the header; not a node. */
  title: string;
  roots: MindMapModel[];
}

// --- ID generation ---

/**
 * Supplier of fresh node ids. Production code uses {@link generateId}; tests
 * pass a deterministic one so outputs can be compared exactly.
 */
export type IdSource = () => string;

export function generateId(): string {
  return crypto.randomUUID();
}

// --- Cloning ---

/** Deep-copy a node subtree. */
export function cloneModel(node: MindMapModel): MindMapModel {
  return JSON.parse(JSON.stringify(node));
}

/** Deep-copy a document. */
export function cloneDocument(doc: MindMapDocument): MindMapDocument {
  return JSON.parse(JSON.stringify(doc));
}

// --- Tree queries ---

/** Find a node by id inside ONE subtree (the given node included). */
export function findInTree(node: MindMapModel, id: string): MindMapModel | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findInTree(child, id);
    if (found) return found;
  }
  return null;
}

/** Find a node by id anywhere in the document (any root, any depth). */
export function findNode(doc: MindMapDocument, id: string): MindMapModel | null {
  for (const root of doc.roots) {
    const found = findInTree(root, id);
    if (found) return found;
  }
  return null;
}

/**
 * Where a node sits: its parent (null for a root), the array it is an element
 * of (`parent.children`, or `doc.roots` for a root) and its index there.
 * `siblings` is the live array of the document passed in, so a caller holding
 * a clone can splice it directly.
 */
export interface NodeLocation {
  parent: MindMapModel | null;
  siblings: MindMapModel[];
  index: number;
}

export function locateNode(doc: MindMapDocument, id: string): NodeLocation | null {
  function walk(parent: MindMapModel | null, siblings: MindMapModel[]): NodeLocation | null {
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].id === id) return { parent, siblings, index: i };
      const found = walk(siblings[i], siblings[i].children);
      if (found) return found;
    }
    return null;
  }
  return walk(null, doc.roots);
}

/**
 * Is `nodeId` one of the document's roots? Roots are created only on purpose
 * (context menu on empty canvas → {@link addRootAt}, or an explicit outdent /
 * drag out of a tree); every "add a sibling" path that ordinary typing hits
 * (Enter, split, paste) treats a root like the classic single mind-map root —
 * the new node becomes its child — so a tree never appears as a side effect
 * of typing.
 */
export function isRoot(doc: MindMapDocument, nodeId: string): boolean {
  return doc.roots.some((r) => r.id === nodeId);
}

/** Append a blank tree root placed at a canvas position. */
export function addRootAt(
  doc: MindMapDocument,
  newNode: MindMapModel,
  position: NodePosition
): MindMapDocument {
  const cloned = cloneDocument(doc);
  cloned.roots.push({ ...newNode, position: { ...position } });
  return cloned;
}

/**
 * Id every "nothing else to focus on" fallback lands on: the first root.
 * Relies on the non-empty `roots` invariant (see {@link MindMapDocument}).
 */
export function firstRootId(doc: MindMapDocument): string {
  return doc.roots[0].id;
}

/**
 * Restore the non-empty `roots` invariant. Returns the document unchanged
 * when it already has a root, otherwise a copy with one blank root.
 */
export function ensureRoot(
  doc: MindMapDocument,
  nextId: IdSource = generateId
): MindMapDocument {
  if (doc.roots.length > 0) return doc;
  return { ...doc, roots: [{ id: nextId(), text: "", children: [] }] };
}

/** Replace the title. Returns a new document. */
export function setDocumentTitle(doc: MindMapDocument, title: string): MindMapDocument {
  return { ...doc, title };
}

/**
 * The tree-visibility rule shared by keyboard navigation ({@link getFlatOrder}),
 * canvas layout (`flattenToNodes` in application/nodeUtils.ts) and the outline
 * row list (`outlineRows` in application/outline.ts): a collapsed node hides its
 * descendants entirely. Defining the rule once here keeps the three
 * traversals — which independently need it for three different output
 * shapes — from drifting apart.
 */
export type VisibleChildren =
  | { kind: "none" }
  | { kind: "recurse"; children: MindMapModel[] };

export function visibleChildrenOf(node: MindMapModel): VisibleChildren {
  if (node.collapsed) return { kind: "none" };
  return { kind: "recurse", children: node.children };
}

/**
 * DFS order of node IDs (navigation order): root by root, each with its
 * visible descendants. Descendants of a collapsed node are skipped so
 * keyboard navigation never lands on a hidden node.
 */
export function getFlatOrder(doc: MindMapDocument): string[] {
  const result: string[] = [];
  function walk(node: MindMapModel) {
    result.push(node.id);
    const vis = visibleChildrenOf(node);
    if (vis.kind === "none") return;
    for (const child of vis.children) walk(child);
  }
  for (const root of doc.roots) walk(root);
  return result;
}

/** Map of node id → depth (roots = 0). */
export function getNodeDepths(doc: MindMapDocument): Map<string, number> {
  const depths = new Map<string, number>();
  function walk(node: MindMapModel, depth: number) {
    depths.set(node.id, depth);
    for (const child of node.children) walk(child, depth + 1);
  }
  for (const root of doc.roots) walk(root, 0);
  return depths;
}

// --- Tree mutations (all return a new document) ---

/**
 * Attach `node` under `parent` at `index` (default: last), IN PLACE on an
 * already-cloned tree. The one place the two rules of nesting live:
 *  - the destination is expanded: content must never be created or moved
 *    into a hidden slot, or the focus would land on a node nobody can see
 *    (see visibleChildrenOf);
 *  - the node's canvas `position` (which only a root has) is dropped, so a
 *    stale one can't resurface when it is later dedented back to a root.
 * Every path that nests a node — creation, split, indent, paste, drag & drop
 * — goes through this, so a new path can't forget either rule.
 */
export function nestUnder(
  parent: MindMapModel,
  node: MindMapModel,
  index: number = parent.children.length
): void {
  parent.collapsed = false;
  delete node.position;
  parent.children.splice(index, 0, node);
}

/** All ids of a subtree, the node itself first (DFS, collapse ignored). */
export function subtreeIds(node: MindMapModel): string[] {
  return [node.id, ...node.children.flatMap(subtreeIds)];
}

export function updateNodeText(
  doc: MindMapDocument,
  nodeId: string,
  text: string
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (node) node.text = text;
  return cloned;
}

/**
 * Insert `newNode` right after `afterId` among its siblings. A root takes the
 * new node as its LAST CHILD instead (see {@link isRoot}): a sibling of a root
 * would be a new tree.
 */
export function addSiblingAfter(
  doc: MindMapDocument,
  afterId: string,
  newNode: MindMapModel
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, afterId);
  if (!loc) return cloned;
  if (loc.parent === null) {
    nestUnder(loc.siblings[loc.index], { ...newNode });
    return cloned;
  }
  nestUnder(loc.parent, { ...newNode }, loc.index + 1);
  return cloned;
}

/** Set a node's kind. Returns a new document. `text` is stored as absent. */
export function setNodeType(
  doc: MindMapDocument,
  nodeId: string,
  type: NodeType
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (!node) return cloned;
  node.type = type === "text" ? undefined : type;
  return cloned;
}

/** Set a text node's formatting (font size / bold). Returns a new document. */
export function setNodeStyle(
  doc: MindMapDocument,
  nodeId: string,
  style: { fontSize?: number | null; bold?: boolean }
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (node) {
    if (style.fontSize !== undefined) {
      if (style.fontSize === null) delete node.fontSize;
      else node.fontSize = style.fontSize;
    }
    if (style.bold !== undefined) {
      if (style.bold) node.bold = true;
      else delete node.bold;
    }
  }
  return cloned;
}

/** Set a link node's fetched metadata (title / favicon). Returns a new document. */
export function setLinkMeta(
  doc: MindMapDocument,
  nodeId: string,
  meta: { linkTitle?: string; favicon?: string | null }
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (node) {
    if (meta.linkTitle !== undefined) {
      if (meta.linkTitle) node.linkTitle = meta.linkTitle;
      else delete node.linkTitle;
    }
    if (meta.favicon !== undefined) {
      if (meta.favicon) node.favicon = meta.favicon;
      else delete node.favicon;
    }
  }
  return cloned;
}

/**
 * Set a node's task checkbox. `null` REMOVES it — the node stops being a task
 * rather than becoming an open one, mirroring how setNodeStyle's `null` clears
 * a font size back to absent. Returns a new document.
 */
export function setChecked(
  doc: MindMapDocument,
  nodeId: string,
  checked: boolean | null
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (node) {
    if (checked === null) delete node.checked;
    else node.checked = checked;
  }
  return cloned;
}

/**
 * Bulk form of {@link setChecked}: apply the same checkbox state to several
 * nodes in one document clone (one undo entry for a multi-select bulk toggle,
 * instead of one per node). Ids that no longer exist are silently skipped —
 * the selection they came from was read from a possibly-stale view.
 */
export function setCheckedMany(
  doc: MindMapDocument,
  nodeIds: readonly string[],
  checked: boolean | null
): MindMapDocument {
  const cloned = cloneDocument(doc);
  for (const nodeId of nodeIds) {
    const node = findNode(cloned, nodeId);
    if (!node) continue;
    if (checked === null) delete node.checked;
    else node.checked = checked;
  }
  return cloned;
}

/**
 * The state the "toggle task" gesture moves a checkbox to — one authority for
 * the keyboard shortcut, the context menu and the click on the box itself:
 *
 *   絶対に無い → ☐ (open) → ☑ (done) → ☐ (open) …
 *
 * The first press turns a plain node INTO a task; after that the gesture only
 * ever flips done/open, so repeating it can never destroy the checkbox (and the
 * completed state) by accident. Removing it again is a separate, explicit
 * action (the context menu / command palette), not the tail of a cycle.
 */
export function nextCheckedState(checked: boolean | undefined): boolean {
  return checked === false;
}

/**
 * The state a BULK "toggle task" gesture (checking several nodes at once)
 * moves the whole group to. A mixed group — some done, some open, some not a
 * task yet — has no single "current" state for {@link nextCheckedState}'s
 * cycle to advance from, so bulk toggling isn't a cycle: check everyone
 * unless they are ALL already done, in which case open them all. That is the
 * one answer that doesn't depend on which node's state happened to be read.
 */
export function nextCheckedStateForGroup(
  checked: readonly (boolean | undefined)[]
): boolean {
  return !checked.every((c) => c === true);
}

/** Toggle (or set) a node's collapsed flag. Returns a new document. */
export function toggleCollapse(
  doc: MindMapDocument,
  nodeId: string,
  collapsed?: boolean
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const node = findNode(cloned, nodeId);
  if (node) node.collapsed = collapsed ?? !node.collapsed;
  return cloned;
}

/** Append newNode as parent's last child. */
export function addChildToNode(
  doc: MindMapDocument,
  parentId: string,
  newNode: MindMapModel
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const parent = findNode(cloned, parentId);
  if (!parent) return cloned;
  nestUnder(parent, { ...newNode });
  return cloned;
}

/**
 * Remove a node. Children are promoted to the node's level (a root's children
 * become roots in its place).
 */
export function removeNode(
  doc: MindMapDocument,
  nodeId: string
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  if (!loc) return cloned;
  const removed = loc.siblings.splice(loc.index, 1)[0];
  loc.siblings.splice(loc.index, 0, ...removed.children);
  return cloned;
}

/**
 * Detach a node together with its WHOLE subtree (unlike removeNode, children
 * are NOT promoted). Returns the new document and the removed subtree as an
 * independent clone. Unknown id → { doc, removed: null }. Detaching the last
 * root leaves `roots` empty — callers restore the invariant with
 * {@link ensureRoot}.
 */
export function detachBranch(
  doc: MindMapDocument,
  nodeId: string
): { doc: MindMapDocument; removed: MindMapModel | null } {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  if (!loc) return { doc: cloned, removed: null };
  const [removed] = loc.siblings.splice(loc.index, 1);
  return { doc: cloned, removed };
}

/**
 * Where focus should land after `nodeId` (found in `doc`, the pre-detach
 * state) is gone from `newDoc`: its flat-order predecessor if it still exists
 * there, else the first root. When the last root was the one detached there
 * is nothing left to land on: `nodeId` is returned as-is, and the caller's
 * {@link ensureRoot} step (see editorReducer) supplies the blank root that
 * takes the focus instead.
 */
export function landOnPredecessor(
  doc: MindMapDocument,
  nodeId: string,
  newDoc: MindMapDocument
): string {
  const order = getFlatOrder(doc);
  const idx = order.indexOf(nodeId);
  const prevId = idx > 0 ? order[idx - 1] : null;
  if (prevId && findNode(newDoc, prevId)) return prevId;
  return newDoc.roots.length > 0 ? firstRootId(newDoc) : nodeId;
}

/**
 * Deep-clone a subtree, assigning a fresh id to every node. Text, kind and
 * formatting are preserved. Used when pasting a branch so the copy never shares
 * ids with the source.
 */
export function cloneWithNewIds(
  node: MindMapModel,
  nextId: IdSource = generateId
): MindMapModel {
  const id = nextId(); // parent-first, DFS
  return {
    ...cloneModel(node),
    id,
    children: node.children.map((c) => cloneWithNewIds(c, nextId)),
  };
}

/**
 * Put a tree at a free canvas position. A root just gets the position; a
 * nested node is detached from its parent (with its subtree) and appended as a
 * new root there — this is how dragging a branch out into empty space would
 * create a new tree. Returns the same reference when the node doesn't exist.
 */
export function placeBranchAt(
  doc: MindMapDocument,
  nodeId: string,
  position: NodePosition
): MindMapDocument {
  if (!findNode(doc, nodeId)) return doc;
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId)!;
  const node = loc.siblings[loc.index];
  if (loc.parent !== null) {
    loc.siblings.splice(loc.index, 1);
    cloned.roots.push(node);
  }
  node.position = { x: position.x, y: position.y };
  return cloned;
}

/**
 * Indent: make node the last child of its previous sibling (for a root: of
 * the previous root, which merges the two trees). Expands the sibling first
 * if it was collapsed — like addChildToNode/moveBranch's callers, this must
 * never move content into a hidden destination (see
 * {@link visibleChildrenOf}); the sibling being collapsed doesn't hide
 * itself, so the node being indented could otherwise vanish from
 * `getFlatOrder` while still being the active node.
 */
export function indentNode(
  doc: MindMapDocument,
  nodeId: string
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  if (!loc || loc.index === 0) return cloned;
  const node = loc.siblings[loc.index];
  const prevSibling = loc.siblings[loc.index - 1];
  loc.siblings.splice(loc.index, 1);
  nestUnder(prevSibling, node);
  return cloned;
}

/**
 * Dedent: move node to its parent's level, right after the parent. A child of
 * a root therefore becomes a new root (an explicit outdent is one of the
 * deliberate ways to create a tree). A root itself has nowhere to go → no-op.
 */
export function dedentNode(
  doc: MindMapDocument,
  nodeId: string
): MindMapDocument {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  if (!loc || loc.parent === null) return cloned;
  const grand = locateNode(cloned, loc.parent.id)!;
  const node = loc.siblings[loc.index];
  loc.siblings.splice(loc.index, 1);
  grand.siblings.splice(grand.index + 1, 0, node);
  return cloned;
}

/**
 * Reorder: swap a node with its previous sibling (moves it up among siblings;
 * for a root, among the roots). Depth is unchanged. Returns the SAME document
 * reference when the move is impossible (unknown id, or already first), so
 * callers can treat identity as "no-op" and skip undo/save bookkeeping.
 */
export function moveNodeUp(doc: MindMapDocument, nodeId: string): MindMapDocument {
  const loc = locateNode(doc, nodeId);
  if (!loc || loc.index === 0) return doc;
  const cloned = cloneDocument(doc);
  const { siblings, index } = locateNode(cloned, nodeId)!;
  [siblings[index - 1], siblings[index]] = [siblings[index], siblings[index - 1]];
  return cloned;
}

/**
 * Reorder: swap a node with its next sibling (moves it down among siblings).
 * Mirror of moveNodeUp; returns the SAME reference when it's already last.
 */
export function moveNodeDown(doc: MindMapDocument, nodeId: string): MindMapDocument {
  const loc = locateNode(doc, nodeId);
  if (!loc || loc.index >= loc.siblings.length - 1) return doc;
  const cloned = cloneDocument(doc);
  const { siblings, index } = locateNode(cloned, nodeId)!;
  [siblings[index + 1], siblings[index]] = [siblings[index], siblings[index + 1]];
  return cloned;
}

/**
 * Reparent/reorder: move a node together with its WHOLE subtree under a new
 * parent node. `index` is the insertion position in the new parent's children
 * as they are BEFORE the move (undefined = append); a same-parent move
 * compensates for the slot freed by the removal. A root moved this way stops
 * being a tree (its canvas position is dropped). Returns the SAME document
 * reference when the move is impossible or a no-op — dropping on itself or
 * one of its own descendants, unknown ids, or a position identical to the
 * current one — so callers can treat identity as "skip undo/save".
 */
export function moveBranch(
  doc: MindMapDocument,
  nodeId: string,
  newParentId: string,
  index?: number
): MindMapDocument {
  if (nodeId === newParentId) return doc;
  const node = findNode(doc, nodeId);
  if (!node) return doc;
  // The new parent must not live inside the moved subtree (cycle guard).
  if (findInTree(node, newParentId)) return doc;
  const newParent = findNode(doc, newParentId);
  if (!newParent) return doc;
  const cur = locateNode(doc, nodeId)!;

  // No-op positions: already the last child on an append, or an index that
  // resolves to the node's current slot.
  if (cur.parent?.id === newParentId) {
    const last = cur.siblings.length - 1;
    if (index === undefined && cur.index === last) return doc;
    if (index !== undefined && (index === cur.index || index === cur.index + 1))
      return doc;
  }

  const cloned = cloneDocument(doc);
  const from = locateNode(cloned, nodeId)!;
  const [moved] = from.siblings.splice(from.index, 1);
  const target = findNode(cloned, newParentId)!;
  if (index === undefined) {
    nestUnder(target, moved);
  } else {
    // Same-parent move: the removal shifted later slots down by one.
    const shift = from.parent?.id === newParentId && from.index < index ? 1 : 0;
    const at = Math.max(0, Math.min(index - shift, target.children.length));
    nestUnder(target, moved, at);
  }
  return cloned;
}

/**
 * Line-join for outline editing (Backspace at the start of a line): merge a
 * node into its *structural* predecessor, NOT the flat DFS-previous node (which
 * is often the deepest leaf of an unrelated sibling subtree, so the text would
 * splice into a foreign branch and the node's children would be orphaned up to
 * the grandparent). The predecessor is:
 *   - the node's previous sibling if it has one (for a root: the previous
 *     root, joining the two trees) — the node's text is appended to that
 *     sibling and the node's children become the sibling's trailing children
 *     (expanding the sibling first if it was collapsed, so the merged-in
 *     children stay visible — see {@link indentNode}); or
 *   - otherwise the node's parent — the text is appended to the parent and the
 *     node's children take the node's former slot (as `removeNode` would). The
 *     parent can't be collapsed here: a collapsed node hides its own
 *     descendants (including `node`, which is being merged), so `node`
 *     couldn't have been reachable/active in the first place.
 * The first root has neither → returns null (caller treats as no-op).
 *
 * Returns the new document, the id the caret should land on (the merge target)
 * and the caret offset (the target's text length *before* the merge).
 */
export function mergeIntoPredecessor(
  doc: MindMapDocument,
  nodeId: string
): { doc: MindMapDocument; targetId: string; caretPos: number } | null {
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  if (!loc) return null;
  const node = loc.siblings[loc.index];

  if (loc.index > 0) {
    // Merge into the previous sibling; children trail the sibling's own.
    const target = loc.siblings[loc.index - 1];
    target.collapsed = false;
    const caretPos = target.text.length;
    target.text += node.text;
    target.children.push(...node.children);
    loc.siblings.splice(loc.index, 1);
    return { doc: cloned, targetId: target.id, caretPos };
  }

  if (loc.parent === null) return null; // the first root: nothing before it

  // First child: merge into the parent; the node's children take its slot.
  const target = loc.parent;
  const caretPos = target.text.length;
  target.text += node.text;
  loc.siblings.splice(loc.index, 1, ...node.children);
  return { doc: cloned, targetId: target.id, caretPos };
}

/**
 * Forward line-join (Delete at the end of a line): pull the node's structural
 * successor up into it. Mirror of {@link mergeIntoPredecessor}. The successor
 * is the node's first *visible* child if it has one (its grandchildren then
 * take that child's slot), otherwise the node's next sibling (whose children
 * are appended to the node; for a root that is the next root, joining the two
 * trees). When the node has neither — its DFS-successor would live in an
 * unrelated, shallower subtree — the SAME document reference is returned so
 * callers can treat identity as "no-op".
 */
export function mergeSuccessorInto(
  doc: MindMapDocument,
  nodeId: string
): MindMapDocument {
  const node = findNode(doc, nodeId);
  if (!node || !hasStructuralSuccessor(doc, nodeId)) return doc;

  if (!node.collapsed && node.children.length > 0) {
    const cloned = cloneDocument(doc);
    const target = findNode(cloned, nodeId)!;
    const clonedChild = target.children[0];
    target.text += clonedChild.text;
    target.children.splice(0, 1, ...clonedChild.children);
    return cloned;
  }

  const loc = locateNode(doc, nodeId)!;
  if (loc.index < loc.siblings.length - 1) {
    const cloned = cloneDocument(doc);
    const cl = locateNode(cloned, nodeId)!;
    const target = cl.siblings[cl.index];
    const clonedSibling = cl.siblings[cl.index + 1];
    target.text += clonedSibling.text;
    target.children.push(...clonedSibling.children);
    cl.siblings.splice(cl.index + 1, 1);
    return cloned;
  }

  return doc;
}

/**
 * Does Delete at the end of this node have something to pull up — a first
 * visible child or a next sibling (see {@link mergeSuccessorInto})? Cheap
 * (no clone), so the keymap can ask before deciding to handle the key.
 */
export function hasStructuralSuccessor(doc: MindMapDocument, nodeId: string): boolean {
  const node = findNode(doc, nodeId);
  if (!node) return false;
  if (!node.collapsed && node.children.length > 0) return true;
  const loc = locateNode(doc, nodeId);
  return !!loc && loc.index < loc.siblings.length - 1;
}

/**
 * Split a node at cursor position. The suffix becomes a following sibling —
 * for a root, its FIRST CHILD instead (a sibling of a root would be a new
 * tree; see {@link isRoot}).
 */
export function splitNode(
  doc: MindMapDocument,
  nodeId: string,
  atPos: number,
  nextId: IdSource = generateId
): { doc: MindMapDocument; newNodeId: string } {
  const newNodeId = nextId();
  const cloned = cloneDocument(doc);
  const loc = locateNode(cloned, nodeId);
  // Fall back to the first root (always exists) so the postcondition holds:
  // newNodeId must identify a node present in the returned document.
  if (!loc) return { doc: cloned, newNodeId: firstRootId(cloned) };
  const node = loc.siblings[loc.index];

  if (atPos <= 0) {
    // Splitting at the very start inserts an empty sibling *before* the node
    // and keeps the node's id, full text and children intact — a node's
    // identity (referenced by image/link/publish URLs) must never migrate to a
    // new id just because a blank line was inserted above it.
    const newNode: MindMapModel = { id: newNodeId, text: "", children: [] };
    if (loc.parent === null) {
      // Root: no sibling (that would be a new tree); prepend an empty child.
      nestUnder(node, newNode, 0);
    } else {
      loc.siblings.splice(loc.index, 0, newNode);
    }
    return { doc: cloned, newNodeId };
  }

  const textAfter = node.text.substring(atPos);
  node.text = node.text.substring(0, atPos);
  // The suffix becomes a following sibling; the node keeps its id and children.
  const newNode: MindMapModel = { id: newNodeId, text: textAfter, children: [] };

  if (loc.parent === null) {
    nestUnder(node, newNode, 0);
  } else {
    loc.siblings.splice(loc.index + 1, 0, newNode);
  }
  return { doc: cloned, newNodeId };
}
