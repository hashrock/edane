/**
 * Domain layer: pure tree model and operations.
 * No framework or rendering dependencies.
 */

/** Node kind. `text` is the default; `image`/`link` store their URL in `text`. */
export type NodeType = "text" | "image" | "link";

/**
 * Node kind as stored in JSON. `"text"` is represented by absence so that
 * the common case adds no bytes. Use `NodeType` when you need the resolved kind.
 */
type StoredNodeType = Exclude<NodeType, "text">;

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
}

// --- ID generation ---

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
 * DFS order of node IDs (navigation order). Descendants of a collapsed node are
 * skipped so keyboard navigation never lands on a hidden node.
 */
export function getFlatOrder(model: MindMapModel): string[] {
  const result: string[] = [];
  function walk(node: MindMapModel) {
    result.push(node.id);
    if (node.collapsed) return;
    for (const child of node.children) walk(child);
  }
  walk(model);
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

export function addSiblingAfter(
  model: MindMapModel,
  afterId: string,
  newNode: MindMapModel
): MindMapModel {
  const cloned = cloneModel(model);
  if (cloned.id === afterId) {
    cloned.children.push(newNode);
    return cloned;
  }
  const result = findParentAndIndex(cloned, afterId);
  if (!result) return cloned;
  result.parent.children.splice(result.index + 1, 0, newNode);
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
  if (node) node.type = type === "text" ? undefined : type;
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

export function addChildToNode(
  model: MindMapModel,
  parentId: string,
  newNode: MindMapModel
): MindMapModel {
  const cloned = cloneModel(model);
  const parent = findNode(cloned, parentId);
  if (parent) parent.children.push(newNode);
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
export function cloneWithNewIds(node: MindMapModel): MindMapModel {
  return {
    ...cloneModel(node),
    id: generateId(),
    children: node.children.map(cloneWithNewIds),
  };
}

/** Indent: make node the last child of its previous sibling */
export function indentNode(
  model: MindMapModel,
  nodeId: string
): MindMapModel {
  const cloned = cloneModel(model);
  if (cloned.id === nodeId) return cloned;
  const result = findParentAndIndex(cloned, nodeId);
  if (!result || result.index === 0) return cloned;
  const [node] = result.parent.children.splice(result.index, 1);
  const prevSibling = result.parent.children[result.index - 1];
  prevSibling.children.push(node);
  return cloned;
}

/** Dedent: move node to parent's level, after parent */
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
  const [node] = result.parent.children.splice(result.index, 1);
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
 * Line-join for outline editing (Backspace at the start of a line): merge a
 * node into its *structural* predecessor, NOT the flat DFS-previous node (which
 * is often the deepest leaf of an unrelated sibling subtree, so the text would
 * splice into a foreign branch and the node's children would be orphaned up to
 * the grandparent). The predecessor is:
 *   - the node's previous sibling if it has one — the node's text is appended
 *     to that sibling and the node's children become the sibling's trailing
 *     children; or
 *   - otherwise the node's parent — the text is appended to the parent and the
 *     node's children take the node's former slot (as `removeNode` would).
 * The root has no predecessor → returns null (caller treats as no-op).
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
  const node = info.parent.children[info.index];

  if (info.index > 0) {
    // Merge into the previous sibling; children trail the sibling's own.
    const target = info.parent.children[info.index - 1];
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
  if (!node) return model;

  if (!node.collapsed && node.children.length > 0) {
    const cloned = cloneModel(model);
    const target = findNode(cloned, nodeId)!;
    const child = target.children[0];
    target.text += child.text;
    target.children.splice(0, 1, ...child.children);
    return cloned;
  }

  const info = findParentAndIndex(model, nodeId);
  if (info && info.index < info.parent.children.length - 1) {
    const cloned = cloneModel(model);
    const ci = findParentAndIndex(cloned, nodeId)!;
    const target = ci.parent.children[ci.index];
    const sibling = ci.parent.children[ci.index + 1];
    target.text += sibling.text;
    target.children.push(...sibling.children);
    ci.parent.children.splice(ci.index + 1, 1);
    return cloned;
  }

  return model;
}

/** Split a node at cursor position */
export function splitNode(
  model: MindMapModel,
  nodeId: string,
  atPos: number
): { model: MindMapModel; newNodeId: string } {
  const newNodeId = generateId();
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
    if (cloned.id === nodeId) {
      // Root has no sibling; fall back to prepending an empty child.
      cloned.children.unshift(newNode);
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

  if (cloned.id === nodeId) {
    cloned.children.unshift(newNode);
  } else {
    const result = findParentAndIndex(cloned, nodeId);
    if (result) {
      result.parent.children.splice(result.index + 1, 0, newNode);
    }
  }
  return { model: cloned, newNodeId };
}
