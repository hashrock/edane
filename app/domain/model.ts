/**
 * Domain layer: pure tree model and operations.
 * No framework or rendering dependencies.
 */

/** Tree node model (stored as JSON) */
export interface MindMapModel {
  id: string;
  text: string;
  children: MindMapModel[];
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

/** DFS order of node IDs (navigation order) */
export function getFlatOrder(model: MindMapModel): string[] {
  const result: string[] = [];
  function walk(node: MindMapModel) {
    result.push(node.id);
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

/** Delete a range of nodes spanning from node1:offset1 to node2:offset2.
 *  Text before the start offset and after the end offset is merged into
 *  the start node. All nodes in between (and the end node) are removed. */
export function deleteNodeRange(
  model: MindMapModel,
  node1Id: string,
  offset1: number,
  node2Id: string,
  offset2: number
): { model: MindMapModel; cursorNodeId: string; cursorOffset: number } {
  const order = getFlatOrder(model);
  let sIdx = order.indexOf(node1Id);
  let eIdx = order.indexOf(node2Id);
  let startId = node1Id,
    startOffset = offset1;
  let endId = node2Id,
    endOffset = offset2;

  if (sIdx > eIdx) {
    startId = node2Id;
    startOffset = offset2;
    endId = node1Id;
    endOffset = offset1;
    [sIdx, eIdx] = [eIdx, sIdx];
  }

  const startNode = findNode(model, startId);
  const endNode = findNode(model, endId);
  if (!startNode || !endNode)
    return { model, cursorNodeId: startId, cursorOffset: startOffset };

  const mergedText =
    startNode.text.substring(0, startOffset) +
    endNode.text.substring(endOffset);
  const cursorOffset = startOffset;

  // Remove all nodes in range except start (reverse order)
  let result = model;
  for (let i = eIdx; i > sIdx; i--) {
    result = removeNode(result, order[i]);
  }

  result = updateNodeText(result, startId, mergedText);

  return { model: result, cursorNodeId: startId, cursorOffset };
}
