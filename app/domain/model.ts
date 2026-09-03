/**
 * Domain layer: pure tree model and operations.
 * No framework or rendering dependencies.
 */
import { isKeyOf } from "./isKeyOf";

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
 * at the type level.
 */
const STORED_NODE_TYPE_SET = {
  image: true,
  link: true,
  markdown: true,
} as const satisfies Record<StoredNodeType, true>;

export function isStoredNodeType(value: unknown): value is StoredNodeType {
  return isKeyOf(STORED_NODE_TYPE_SET, value);
}

/**
 * The non-"text" `NodeType` members as an array, derived from
 * {@link STORED_NODE_TYPE_SET} so callers that need to enumerate them (rather
 * than just test membership via {@link isStoredNodeType}) stay in sync
 * automatically when a `NodeType` member is added, renamed, or removed.
 */
export const STORED_NODE_TYPES = Object.keys(STORED_NODE_TYPE_SET) as StoredNodeType[];

/** Every `NodeType`, the default first. */
export const NODE_TYPES: NodeType[] = ["text", ...STORED_NODE_TYPES];

/** Tree node model (stored as JSON) */
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
   * Only meaningful on a top-level node (see {@link topLevelNodes}): a placed
   * tree stays where the user dropped it, an unplaced one is auto-stacked
   * below the others. Ignored (and dropped by `moveBranch`) once the node is
   * nested under another.
   */
  position?: NodePosition;
}

export interface NodePosition {
  x: number;
  y: number;
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

// --- Tree queries ---

export function cloneModel(model: MindMapModel): MindMapModel {
  return JSON.parse(JSON.stringify(model));
}

export function findNode(
  model: MindMapModel,
  id: string
): MindMapModel | null {
  if (model.id === id) return model;
  for (const child of model.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findParentAndIndex(
  model: MindMapModel,
  id: string
): { parent: MindMapModel; index: number } | null {
  for (let i = 0; i < model.children.length; i++) {
    if (model.children[i].id === id) {
      return { parent: model, index: i };
    }
    const found = findParentAndIndex(model.children[i], id);
    if (found) return found;
  }
  return null;
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
 * The root is the note itself, not a node: it holds the title (edited in the
 * header) and its children are the top-level nodes, which the canvas and the
 * outline present as independent trees ("multi-root"). The root is never
 * visible, navigable or editable as a node — every traversal that produces a
 * visible/navigable set ({@link getFlatOrder}, `flattenToNodes`,
 * `outlineRows`) starts from `topLevelNodes` instead of the root.
 */
export function topLevelNodes(model: MindMapModel): MindMapModel[] {
  return model.children;
}

/**
 * Is `nodeId` a top-level node (a tree root)? Tree roots are created only on
 * purpose (context menu on empty canvas → {@link addRootAt}); every "add a
 * sibling" path (Enter, split, paste) treats a top-level node the way the old
 * single root was treated — the new node becomes its child — so a root never
 * appears as a side effect of ordinary typing.
 */
export function isTopLevel(model: MindMapModel, nodeId: string): boolean {
  return model.children.some((c) => c.id === nodeId);
}

/** Add a blank tree root placed at a canvas position. */
export function addRootAt(
  model: MindMapModel,
  newNode: MindMapModel,
  position: NodePosition
): MindMapModel {
  const cloned = cloneModel(model);
  cloned.children.push({ ...newNode, position: { ...position } });
  return cloned;
}

/**
 * Id every "nothing else to focus on" fallback lands on: the first top-level
 * node. Falls back to the root id only for a childless root (which the editor
 * never produces — see `ensureTopLevelNode`), so callers never get an id that
 * doesn't exist.
 */
export function firstNavigableId(model: MindMapModel): string {
  return model.children[0]?.id ?? model.id;
}

/**
 * A document must always have at least one top-level node, or there would be
 * nothing to select and no way to start typing. Returns the model unchanged
 * when it already has one, otherwise a copy with a blank top-level node.
 */
export function ensureTopLevelNode(
  model: MindMapModel,
  nextId: IdSource = generateId
): MindMapModel {
  if (model.children.length > 0) return model;
  return { ...model, children: [{ id: nextId(), text: "", children: [] }] };
}

/**
 * DFS order of node IDs (navigation order), starting at the top-level nodes —
 * the root is not part of it (see {@link topLevelNodes}). Descendants of a
 * collapsed node are skipped so keyboard navigation never lands on a hidden
 * node.
 */
export function getFlatOrder(model: MindMapModel): string[] {
  const result: string[] = [];
  function walk(node: MindMapModel) {
    result.push(node.id);
    const vis = visibleChildrenOf(node);
    if (vis.kind === "none") return;
    for (const child of vis.children) walk(child);
  }
  for (const top of topLevelNodes(model)) walk(top);
  return result;
}

/** Map of node id → depth (root = 0). */
export function getNodeDepths(model: MindMapModel): Map<string, number> {
  const depths = new Map<string, number>();
  function walk(node: MindMapModel, depth: number) {
    depths.set(node.id, depth);
    for (const child of node.children) walk(child, depth + 1);
  }
  walk(model, 0);
  return depths;
}

// --- Tree mutations (all return new model) ---

export function updateNodeText(
  model: MindMapModel,
  nodeId: string,
  text: string
): MindMapModel {
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  if (node) node.text = text;
  return cloned;
}

/**
 * Attach `node` under `parent` at `index` (default: last), IN PLACE on an
 * already-cloned tree. The one place the two rules of nesting live:
 *  - the destination is expanded (unless it is the invisible root): content
 *    must never be created or moved into a hidden slot, or the focus would
 *    land on a node nobody can see (see visibleChildrenOf);
 *  - the node's canvas `position` (which only a top-level tree has) is
 *    dropped, so a stale one can't resurface when it is later dedented back
 *    to the top level.
 * Every path that nests a node — creation, split, indent, paste, drag & drop
 * — goes through this, so a new path can't forget either rule.
 */
export function nestUnder(
  parent: MindMapModel,
  node: MindMapModel,
  index: number = parent.children.length,
  rootId?: string
): void {
  if (parent.id !== rootId) {
    parent.collapsed = false;
    delete node.position;
  }
  parent.children.splice(index, 0, node);
}

/** All ids of a subtree, the node itself first (DFS, collapse ignored). */
export function subtreeIds(node: MindMapModel): string[] {
  return [node.id, ...node.children.flatMap(subtreeIds)];
}

export function addSiblingAfter(
  model: MindMapModel,
  afterId: string,
  newNode: MindMapModel
): MindMapModel {
  const cloned = cloneModel(model);
  // The root and the tree roots take the new node as a child instead (see
  // isTopLevel): siblings of a tree root would be new trees.
  if (cloned.id === afterId || isTopLevel(cloned, afterId)) {
    nestUnder(findNode(cloned, afterId)!, { ...newNode }, undefined, cloned.id);
    return cloned;
  }
  const result = findParentAndIndex(cloned, afterId);
  if (!result) return cloned;
  nestUnder(result.parent, { ...newNode }, result.index + 1, cloned.id);
  return cloned;
}

/** Set a node's kind. Returns a new model. `text` is stored as absent. */
export function setNodeType(
  model: MindMapModel,
  nodeId: string,
  type: NodeType
): MindMapModel {
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  if (!node) return cloned;
  node.type = type === "text" ? undefined : type;
  return cloned;
}

/** Set a text node's formatting (font size / bold). Returns a new model. */
export function setNodeStyle(
  model: MindMapModel,
  nodeId: string,
  style: { fontSize?: number | null; bold?: boolean }
): MindMapModel {
  const cloned = cloneModel(model);
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

/** Set a link node's fetched metadata (title / favicon). Returns a new model. */
export function setLinkMeta(
  model: MindMapModel,
  nodeId: string,
  meta: { linkTitle?: string; favicon?: string | null }
): MindMapModel {
  const cloned = cloneModel(model);
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
 * a font size back to absent. Returns a new model.
 */
export function setChecked(
  model: MindMapModel,
  nodeId: string,
  checked: boolean | null
): MindMapModel {
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  if (node) {
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

/** Toggle (or set) a node's collapsed flag. Returns a new model. */
export function toggleCollapse(
  model: MindMapModel,
  nodeId: string,
  collapsed?: boolean
): MindMapModel {
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  if (node) node.collapsed = collapsed ?? !node.collapsed;
  return cloned;
}

/** Append newNode as parent's last child. */
export function addChildToNode(
  model: MindMapModel,
  parentId: string,
  newNode: MindMapModel
): MindMapModel {
  const cloned = cloneModel(model);
  const parent = findNode(cloned, parentId);
  if (!parent) return cloned;
  // Under the root it becomes a tree (keeps its position); anywhere else it
  // is nested (see nestUnder).
  nestUnder(parent, { ...newNode }, undefined, cloned.id);
  return cloned;
}

/** Remove a node. Children are promoted to the parent level. */
export function removeNode(
  model: MindMapModel,
  nodeId: string
): MindMapModel {
  const cloned = cloneModel(model);
  if (cloned.id === nodeId) return cloned;
  const result = findParentAndIndex(cloned, nodeId);
  if (!result) return cloned;
  const removed = result.parent.children.splice(result.index, 1)[0];
  result.parent.children.splice(result.index, 0, ...removed.children);
  return cloned;
}

/**
 * Detach a node together with its WHOLE subtree (unlike removeNode, children
 * are NOT promoted). Returns the new model and the removed subtree as an
 * independent clone. The root cannot be detached → { model, removed: null }.
 */
export function detachBranch(
  model: MindMapModel,
  nodeId: string
): { model: MindMapModel; removed: MindMapModel | null } {
  if (model.id === nodeId) return { model, removed: null };
  const cloned = cloneModel(model);
  const result = findParentAndIndex(cloned, nodeId);
  if (!result) return { model: cloned, removed: null };
  const [removed] = result.parent.children.splice(result.index, 1);
  return { model: cloned, removed };
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
 * Put a tree at a free canvas position. A top-level node just gets the
 * position; a nested node is detached from its parent (with its subtree) and
 * appended as a new top-level tree there — this is how dragging a branch out
 * into empty space creates a new root. Returns the same reference when the
 * node is the root or doesn't exist.
 */
export function placeBranchAt(
  model: MindMapModel,
  nodeId: string,
  position: NodePosition
): MindMapModel {
  if (model.id === nodeId) return model;
  if (!findNode(model, nodeId)) return model;
  const cloned = cloneModel(model);
  const info = findParentAndIndex(cloned, nodeId)!;
  const node = info.parent.children[info.index];
  if (info.parent.id !== cloned.id) {
    info.parent.children.splice(info.index, 1);
    cloned.children.push(node);
  }
  node.position = { x: position.x, y: position.y };
  return cloned;
}

/**
 * Indent: make node the last child of its previous sibling. Expands the
 * sibling first if it was collapsed — like addChildToNode/moveBranch's
 * callers, this must never move content into a hidden destination (see
 * {@link visibleChildrenOf}); the sibling being collapsed doesn't hide
 * itself, so the node being indented could otherwise vanish from
 * `getFlatOrder` while still being the active node.
 */
export function indentNode(
  model: MindMapModel,
  nodeId: string
): MindMapModel {
  const cloned = cloneModel(model);
  if (cloned.id === nodeId) return cloned;
  const result = findParentAndIndex(cloned, nodeId);
  if (!result || result.index === 0) return cloned;
  const node = result.parent.children[result.index];
  const prevSibling = result.parent.children[result.index - 1];
  result.parent.children.splice(result.index, 1);
  nestUnder(prevSibling, node);
  return cloned;
}

/** Dedent: move node to parent's level, after parent. */
export function dedentNode(
  model: MindMapModel,
  nodeId: string
): MindMapModel {
  const cloned = cloneModel(model);
  if (cloned.id === nodeId) return cloned;
  const result = findParentAndIndex(cloned, nodeId);
  if (!result) return cloned;
  const grandResult = findParentAndIndex(cloned, result.parent.id);
  if (!grandResult) return cloned;
  const node = result.parent.children[result.index];
  result.parent.children.splice(result.index, 1);
  grandResult.parent.children.splice(grandResult.index + 1, 0, node);
  return cloned;
}

/**
 * Reorder: swap a node with its previous sibling (moves it up among siblings).
 * Depth is unchanged — only sibling order changes. Returns the SAME model
 * reference when the move is impossible (root, or already the first child), so
 * callers can treat identity as "no-op" and skip undo/save bookkeeping.
 */
export function moveNodeUp(model: MindMapModel, nodeId: string): MindMapModel {
  if (model.id === nodeId) return model;
  const result = findParentAndIndex(model, nodeId);
  if (!result || result.index === 0) return model;
  const cloned = cloneModel(model);
  const { parent, index } = findParentAndIndex(cloned, nodeId)!;
  const arr = parent.children;
  [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
  return cloned;
}

/**
 * Reorder: swap a node with its next sibling (moves it down among siblings).
 * Mirror of moveNodeUp; returns the SAME reference when it's the last child or
 * the root.
 */
export function moveNodeDown(model: MindMapModel, nodeId: string): MindMapModel {
  if (model.id === nodeId) return model;
  const result = findParentAndIndex(model, nodeId);
  if (!result || result.index >= result.parent.children.length - 1) return model;
  const cloned = cloneModel(model);
  const { parent, index } = findParentAndIndex(cloned, nodeId)!;
  const arr = parent.children;
  [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
  return cloned;
}

/**
 * Reparent/reorder: move a node together with its WHOLE subtree under a new
 * parent. `index` is the insertion position in the new parent's children as
 * they are BEFORE the move (undefined = append); a same-parent move compensates
 * for the slot freed by the removal. Returns the SAME model reference when the
 * move is impossible or a no-op — root move, dropping on itself or one of its
 * own descendants, unknown ids, or a position identical to the current one —
 * so callers can treat identity as "skip undo/save".
 */
export function moveBranch(
  model: MindMapModel,
  nodeId: string,
  newParentId: string,
  index?: number
): MindMapModel {
  if (model.id === nodeId || nodeId === newParentId) return model;
  const node = findNode(model, nodeId);
  if (!node) return model;
  // The new parent must not live inside the moved subtree (cycle guard).
  if (findNode(node, newParentId)) return model;
  const newParent = findNode(model, newParentId);
  if (!newParent) return model;
  const cur = findParentAndIndex(model, nodeId);
  if (!cur) return model;

  // No-op positions: already the last child on an append, or an index that
  // resolves to the node's current slot.
  if (cur.parent.id === newParentId) {
    const last = cur.parent.children.length - 1;
    if (index === undefined && cur.index === last) return model;
    if (index !== undefined && (index === cur.index || index === cur.index + 1))
      return model;
  }

  const cloned = cloneModel(model);
  const { parent, index: removedIndex } = findParentAndIndex(cloned, nodeId)!;
  const [moved] = parent.children.splice(removedIndex, 1);
  const target = findNode(cloned, newParentId)!;
  if (index === undefined) {
    nestUnder(target, moved, undefined, cloned.id);
  } else {
    // Same-parent move: the removal shifted later slots down by one.
    const shift = parent.id === newParentId && removedIndex < index ? 1 : 0;
    const at = Math.max(0, Math.min(index - shift, target.children.length));
    nestUnder(target, moved, at, cloned.id);
  }
  return cloned;
}

/**
 * Line-join for outline editing (Backspace at the start of a line): merge a
 * node into its *structural* predecessor, NOT the flat DFS-previous node (which
 * is often the deepest leaf of an unrelated sibling subtree, so the text would
 * splice into a foreign branch and the node's children would be orphaned up to
 * the grandparent). The predecessor is:
 *   - the node's previous sibling if it has one — the node's text is appended
 *     to that sibling and the node's children become the sibling's trailing
 *     children (expanding the sibling first if it was collapsed, so the
 *     merged-in children stay visible — see {@link indentNode}); or
 *   - otherwise the node's parent — the text is appended to the parent and the
 *     node's children take the node's former slot (as `removeNode` would). The
 *     parent can't be collapsed here: a collapsed node hides its own
 *     descendants (including `node`, which is being merged), so `node`
 *     couldn't have been reachable/active in the first place.
 * The root is not a node (it's the title), so neither the root itself nor the
 * first top-level node has a predecessor → returns null (caller treats as
 * no-op).
 *
 * Returns the new model, the id the caret should land on (the merge target) and
 * the caret offset (the target's text length *before* the merge).
 */
export function mergeIntoPredecessor(
  model: MindMapModel,
  nodeId: string
): { model: MindMapModel; targetId: string; caretPos: number } | null {
  if (model.id === nodeId) return null;
  const cloned = cloneModel(model);
  const info = findParentAndIndex(cloned, nodeId);
  if (!info) return null;
  if (info.parent.id === cloned.id && info.index === 0) return null;
  const node = info.parent.children[info.index];

  if (info.index > 0) {
    // Merge into the previous sibling; children trail the sibling's own.
    const target = info.parent.children[info.index - 1];
    target.collapsed = false;
    const caretPos = target.text.length;
    target.text += node.text;
    target.children.push(...node.children);
    info.parent.children.splice(info.index, 1);
    return { model: cloned, targetId: target.id, caretPos };
  }

  // First child: merge into the parent; the node's children take its slot.
  const target = info.parent;
  const caretPos = target.text.length;
  target.text += node.text;
  info.parent.children.splice(info.index, 1, ...node.children);
  return { model: cloned, targetId: target.id, caretPos };
}

/**
 * Forward line-join (Delete at the end of a line): pull the node's structural
 * successor up into it. Mirror of {@link mergeIntoPredecessor}. The successor
 * is the node's first *visible* child if it has one (its grandchildren then
 * take that child's slot), otherwise the node's next sibling (whose children
 * are appended to the node). When the node has neither — its DFS-successor
 * would live in an unrelated, shallower subtree — the SAME model reference is
 * returned so callers can treat identity as "no-op".
 */
export function mergeSuccessorInto(
  model: MindMapModel,
  nodeId: string
): MindMapModel {
  const node = findNode(model, nodeId);
  if (!node || !hasStructuralSuccessor(model, nodeId)) return model;

  if (!node.collapsed && node.children.length > 0) {
    const cloned = cloneModel(model);
    const target = findNode(cloned, nodeId)!;
    const clonedChild = target.children[0];
    target.text += clonedChild.text;
    target.children.splice(0, 1, ...clonedChild.children);
    return cloned;
  }

  const info = findParentAndIndex(model, nodeId);
  if (info && info.index < info.parent.children.length - 1) {
    const cloned = cloneModel(model);
    const ci = findParentAndIndex(cloned, nodeId)!;
    const target = ci.parent.children[ci.index];
    const clonedSibling = ci.parent.children[ci.index + 1];
    target.text += clonedSibling.text;
    target.children.push(...clonedSibling.children);
    ci.parent.children.splice(ci.index + 1, 1);
    return cloned;
  }

  return model;
}

/**
 * Does Delete at the end of this node have something to pull up — a first
 * visible child or a next sibling (see {@link mergeSuccessorInto})? Cheap
 * (no clone), so the keymap can ask before deciding to handle the key.
 */
export function hasStructuralSuccessor(model: MindMapModel, nodeId: string): boolean {
  const node = findNode(model, nodeId);
  if (!node) return false;
  if (!node.collapsed && node.children.length > 0) return true;
  const info = findParentAndIndex(model, nodeId);
  return !!info && info.index < info.parent.children.length - 1;
}

/** Split a node at cursor position */
export function splitNode(
  model: MindMapModel,
  nodeId: string,
  atPos: number,
  nextId: IdSource = generateId
): { model: MindMapModel; newNodeId: string } {
  const newNodeId = nextId();
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  // Fall back to root id (always exists) so the postcondition holds:
  // newNodeId must identify a node present in the returned model.
  if (!node) return { model: cloned, newNodeId: cloned.id };

  if (atPos <= 0) {
    // Splitting at the very start inserts an empty sibling *before* the node
    // and keeps the node's id, full text and children intact — a node's
    // identity (referenced by image/link/publish URLs) must never migrate to a
    // new id just because a blank line was inserted above it.
    const newNode: MindMapModel = { id: newNodeId, text: "", children: [] };
    if (cloned.id === nodeId || isTopLevel(cloned, nodeId)) {
      // Root / tree root: no sibling (that would be a new tree); prepend an
      // empty child instead.
      nestUnder(node, newNode, 0, cloned.id);
    } else {
      const result = findParentAndIndex(cloned, nodeId);
      if (result) result.parent.children.splice(result.index, 0, newNode);
    }
    return { model: cloned, newNodeId };
  }

  const textAfter = node.text.substring(atPos);
  node.text = node.text.substring(0, atPos);
  // The suffix becomes a following sibling; the node keeps its id and children.
  const newNode: MindMapModel = { id: newNodeId, text: textAfter, children: [] };

  if (cloned.id === nodeId || isTopLevel(cloned, nodeId)) {
    nestUnder(node, newNode, 0, cloned.id);
  } else {
    const result = findParentAndIndex(cloned, nodeId);
    if (result) {
      result.parent.children.splice(result.index + 1, 0, newNode);
    }
  }
  return { model: cloned, newNodeId };
}
