/**
 * Application layer: reading and editing a note from OUTSIDE the editor —
 * the remote MCP server (app/mcp/) is the caller. Pure: document in, document
 * out; loading, decrypting and saving stay in the caller.
 *
 * Every edit is expressed as {@link EditorAction}s run through
 * {@link editorReducer}, so a remote edit keeps exactly the invariants an edit
 * in the browser does (a root always exists, nesting goes through
 * `nestUnder`, records entering a schema'd collection get their fields from
 * `conformEntering`, a root never grows a sibling). Nothing here re-implements
 * a tree operation.
 *
 * The outline is the read format handed to the agent: one line per node with
 * its id, so a later edit can name the node it targets.
 */
import type { IdSource, MindMapDocument, MindMapModel, NodeType } from "../domain/model";
import { ensureRoot, findNode, firstRootId, generateId } from "../domain/model";
import { assertNever } from "../lib/assertNever";
import { editorReducer, type EditorAction, type EditorState } from "./editorReducer";
import { markdownToModel } from "./markdown";

/** Top-level nodes of a Markdown / indented-list snippet (fresh ids). */
export function nodesFromMarkdown(md: string, nextId: IdSource = generateId): MindMapModel[] {
  return markdownToModel(md, nextId).children;
}

/**
 * A new note's document. A snippet with exactly one top-level item becomes
 * that tree; anything else hangs under a root carrying the title — one tree
 * either way (trees are only ever made on purpose, see CLAUDE.md).
 */
export function documentFromMarkdown(
  title: string,
  md: string,
  nextId: IdSource = generateId
): MindMapDocument {
  const nodes = nodesFromMarkdown(md, nextId);
  const roots = nodes.length === 1 ? nodes : [{ id: nextId(), text: title, children: nodes }];
  return ensureRoot({ title, roots }, nextId);
}

// --- Outline (read format) ---

/**
 * One line per node, indented two spaces per level:
 *   `- [x] text {id=…}` — task state as a GFM marker, the kind as a tag for
 *   non-text nodes (`[link] url "title"`), `(collapsed)` when folded.
 * Continuation lines of a multi-line text are indented under their bullet.
 * Collapsed subtrees are listed too: the agent sees the whole note.
 */
export function documentToOutline(doc: MindMapDocument): string {
  const lines: string[] = [`# ${doc.title}`];
  const walk = (n: MindMapModel, depth: number) => {
    const indent = "  ".repeat(depth);
    const box = n.checked === undefined ? "" : n.checked ? "[x] " : "[ ] ";
    const [first, ...rest] = nodeLabel(n).split("\n");
    const folded = n.collapsed && n.children.length > 0 ? " (collapsed)" : "";
    lines.push(`${indent}- ${box}${first} {id=${n.id}}${folded}`);
    for (const line of rest) lines.push(`${indent}  ${line}`);
    for (const child of n.children) walk(child, depth + 1);
  };
  for (const root of doc.roots) walk(root, 0);
  return lines.join("\n");
}

function nodeLabel(n: MindMapModel): string {
  const type: NodeType = n.type ?? "text";
  switch (type) {
    case "text":
      return n.text;
    case "image":
      return `[image] ${n.text}`;
    case "link":
      return n.linkTitle ? `[link] ${n.text} "${n.linkTitle}"` : `[link] ${n.text}`;
    case "markdown":
      return `[markdown] ${n.text}`;
    default:
      return assertNever(type);
  }
}

// --- Edits ---

export type NoteEdit =
  /**
   * Insert nodes (with their subtrees). `parentId`: as the parent's last
   * children. `afterId`: as siblings right after that node — after a root they
   * become its children instead, like every other "sibling of a root". Neither:
   * under the first root.
   */
  | { kind: "addNodes"; nodes: MindMapModel[]; parentId?: string; afterId?: string }
  /** Replace a node's text and/or its checkbox (`null` removes the checkbox). */
  | { kind: "updateNode"; nodeId: string; text?: string; checked?: boolean | null }
  /** Delete a node with its whole subtree. */
  | { kind: "deleteNode"; nodeId: string };

export type NoteEditResult =
  | { ok: true; document: MindMapDocument; /** Ids of the inserted top-level nodes (addNodes). */ nodeIds: string[] }
  | { ok: false; error: string };

function stateFor(doc: MindMapDocument, activeNodeId: string): EditorState {
  return {
    document: { model: doc, clipboard: null },
    view: {
      activeNodeId,
      editing: false,
      editingText: findNode(doc, activeNodeId)?.text ?? "",
      cursorPos: 0,
      selectionEnd: 0,
      lastChildByParent: {},
    },
  };
}

function run(doc: MindMapDocument, action: EditorAction, nextId: IdSource, active = firstRootId(doc)): EditorState {
  return editorReducer(stateFor(doc, active), action, nextId);
}

const missing = (id: string): NoteEditResult => ({ ok: false, error: `Node not found: ${id}` });

export function applyNoteEdit(
  doc: MindMapDocument,
  edit: NoteEdit,
  nextId: IdSource = generateId
): NoteEditResult {
  switch (edit.kind) {
    case "addNodes": {
      if (edit.nodes.length === 0) return { ok: false, error: "Nothing to add" };
      if (edit.parentId !== undefined && edit.afterId !== undefined) {
        return { ok: false, error: "Give parentId or afterId, not both" };
      }
      if (edit.afterId !== undefined) {
        if (!findNode(doc, edit.afterId)) return missing(edit.afterId);
        const next = run(doc, { type: "insertNodes", targetId: edit.afterId, nodes: edit.nodes }, nextId);
        return { ok: true, document: next.document.model, nodeIds: edit.nodes.map((n) => n.id) };
      }
      const parentId = edit.parentId ?? firstRootId(doc);
      if (!findNode(doc, parentId)) return missing(parentId);
      // pasteBranch appends one subtree under the ACTIVE node and focuses it,
      // so the focus after each step is the inserted node's (fresh) id.
      let model = doc;
      const nodeIds: string[] = [];
      for (const node of edit.nodes) {
        const next = run(model, { type: "pasteBranch", node }, nextId, parentId);
        model = next.document.model;
        nodeIds.push(next.view.activeNodeId!);
      }
      return { ok: true, document: model, nodeIds };
    }

    case "updateNode": {
      const { nodeId, text, checked } = edit;
      if (!findNode(doc, nodeId)) return missing(nodeId);
      let model = doc;
      if (text !== undefined) model = run(model, { type: "setNodeContent", nodeId, text }, nextId).document.model;
      if (checked !== undefined) model = run(model, { type: "setChecked", nodeId, checked }, nextId).document.model;
      return { ok: true, document: model, nodeIds: [] };
    }

    case "deleteNode": {
      if (!findNode(doc, edit.nodeId)) return missing(edit.nodeId);
      const next = run(doc, { type: "deleteNode", nodeId: edit.nodeId }, nextId);
      return { ok: true, document: next.document.model, nodeIds: [] };
    }

    default:
      return assertNever(edit);
  }
}
