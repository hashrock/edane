/**
 * Domain layer: pure tree model and operations.
 * No framework or rendering dependencies.
 */

/** Node kind. `text` is the default; `image`/`link` store their URL in `text`. */
export type NodeType = "text" | "image" | "link";

/** Tree node model (stored as JSON) */
export interface MindMapModel {
  id: string;
  text: string;
  children: MindMapModel[];
  /** When true, descendants are hidden in the canvas and skipped in navigation. */
  collapsed?: boolean;
  /** Node kind (absent = "text"). For image/link, `text` holds the URL. */
  type?: NodeType;
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

/** Split a node at cursor position */
export function splitNode(
  model: MindMapModel,
  nodeId: string,
  atPos: number
): { model: MindMapModel; newNodeId: string } {
  const newNodeId = generateId();
  const cloned = cloneModel(model);
  const node = findNode(cloned, nodeId);
  if (!node) return { model: cloned, newNodeId };
  const textAfter = node.text.substring(atPos);
  node.text = node.text.substring(0, atPos);

  // When splitting at the start, children belong to the text portion (newNode)
  const newNode: MindMapModel = {
    id: newNodeId,
    text: textAfter,
    children: atPos === 0 ? node.children : [],
  };
  if (atPos === 0) {
    node.children = [];
  }

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
