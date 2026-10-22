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
 * The outline is the read format handed to the agent: the note as the same
 * Markdown list `add_nodes` reads back, each line tagged with its node id so a
 * later edit can name the node it targets.
 */
import type { IdSource, MindMapDocument, MindMapModel } from "../domain/model";
import { findNode, firstRootId, generateId } from "../domain/model";
import { assertNever } from "../lib/assertNever";
import { editorReducer, freshEditorState, type EditorAction } from "./editorReducer";
import { markdownToModel, modelToMarkdown } from "./markdown";

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
  return { title, roots };
}

/**
 * `# title`, then every tree as a Markdown list (see modelToMarkdown) with
 * ` {id=…}` — and ` (collapsed)` when folded — after each node. Collapsed
 * subtrees are listed too: the agent sees the whole note.
 */
export function documentToOutline(doc: MindMapDocument): string {
  const annotate = (n: MindMapModel) =>
    ` {id=${n.id}}${n.collapsed && n.children.length > 0 ? " (collapsed)" : ""}`;
  return [`# ${doc.title}`, ...doc.roots.map((r) => modelToMarkdown(r, annotate))].join("\n");
}

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
  | { ok: true; document: MindMapDocument; /** Ids of the inserted top-level nodes (addNodes). */ nodeIds?: string[] }
  | { ok: false; error: string };

function run(doc: MindMapDocument, action: EditorAction, nextId: IdSource): MindMapDocument {
  return editorReducer(freshEditorState(doc, firstRootId(doc)), action, nextId).document.model;
}

const missing = (id: string): NoteEditResult => ({ ok: false, error: `Node not found: ${id}` });

export function applyNoteEdit(
  doc: MindMapDocument,
  edit: NoteEdit,
  nextId: IdSource = generateId
): NoteEditResult {
  switch (edit.kind) {
    case "addNodes": {
      const { nodes, parentId, afterId } = edit;
      if (nodes.length === 0) return { ok: false, error: "Nothing to add" };
      if (parentId !== undefined && afterId !== undefined) {
        return { ok: false, error: "Give parentId or afterId, not both" };
      }
      const targetId = afterId ?? parentId ?? firstRootId(doc);
      if (!findNode(doc, targetId)) return missing(targetId);
      const action: EditorAction = { type: "insertNodes", targetId, nodes, into: afterId === undefined };
      return { ok: true, document: run(doc, action, nextId), nodeIds: nodes.map((n) => n.id) };
    }

    case "updateNode": {
      const { nodeId, text, checked } = edit;
      if (!findNode(doc, nodeId)) return missing(nodeId);
      let model = doc;
      if (text !== undefined) model = run(model, { type: "setNodeContent", nodeId, text }, nextId);
      if (checked !== undefined) model = run(model, { type: "setChecked", nodeId, checked }, nextId);
      return { ok: true, document: model };
    }

    case "deleteNode": {
      if (!findNode(doc, edit.nodeId)) return missing(edit.nodeId);
      return { ok: true, document: run(doc, { type: "deleteNode", nodeId: edit.nodeId }, nextId) };
    }

    default:
      return assertNever(edit);
  }
}
