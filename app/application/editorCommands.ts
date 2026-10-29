/**
 * Application layer: multi-step editor operations as effect lists.
 *
 * A paste is not one action. The nodes are inserted (undoable, "paste"),
 * edit mode is left so the next keystroke doesn't become a separate undo
 * entry, the inserted nodes are highlighted and the note is saved. That
 * sequence used to be written out inline in every paste handler (canvas:
 * three copies, outline: one) — which is exactly where the "exitEditing in
 * selection mode deleted the just-pasted blank node" bug hid: no test could
 * see the sequence, only its parts. A command makes the sequence a value —
 * the same `KeyEffect` list a key press produces — so the components run it
 * through applyKeyEffects and the property tests feed the very same steps to
 * the reducer.
 *
 * Pure: no DOM, no React, no dispatch. Ids come from `nextId` so a test can
 * predict the result exactly.
 */
import {
  firstRootId,
  generateId,
  subtreeIds,
  type IdSource,
  type MindMapModel,
} from "../domain/model";
import type { EditorState } from "./editorReducer";
import type { KeyEffect } from "./editorKeymap";
import { markdownToModel } from "./markdown";
import { textToNodes } from "./persistence";
import { orderedRange, rangeTextOf, rangeToPlainText } from "./textRange";
import { assertNever } from "../lib/assertNever";

/** What is being pasted, after the clipboard has been decoded. */
export type PasteSource =
  /** Indented plain text: one node per line, nesting by indentation. */
  | { kind: "text"; text: string }
  /** External Markdown, with the strategy chosen in the paste dialog. */
  | { kind: "markdown"; text: string; mode: "decompose" | "node" | "plain" }
  /**
   * An edane branch: the clipboard's own subtree, or (absent) the internal
   * branch clipboard filled by copyBranch / cutBranch.
   */
  | { kind: "branch"; node?: MindMapModel };

interface PasteOptions {
  /** Node the paste lands on (default: the active node, else the first). */
  targetId?: string;
  nextId?: IdSource;
}

/** The node a paste lands on when nothing more specific is given. */
function pasteTarget(state: EditorState): string {
  return state.view.activeNodeId ?? firstRootId(state.document.model);
}

/**
 * The paste as an effect list, or null when there is nothing to paste (blank
 * text, an outline that parses to no nodes). Ends with a save.
 *
 * Node pastes insert after the target (a tree root takes them as children —
 * see the reducer's insertNodes) and then leave edit mode: if the paste
 * happened while editing, edit mode would otherwise persist (focusView keeps
 * it) and the next keystroke would open a separate "text" undo entry, making
 * the paste feel like it needs two Ctrl+Z. exitEditing is view-only, so it
 * carries no undo type.
 *
 * Precondition (kept by planPaste): a node paste happens in SELECTION mode —
 * while editing, a paste is plain text at the caret. The outline layout does
 * paste indented text while editing; that is safe because textToNodes never
 * yields a blank node, so exitEditing's blank-leaf cleanup has nothing to eat.
 */
export function pasteCommand(
  state: EditorState,
  source: PasteSource,
  opts: PasteOptions = {}
): KeyEffect[] | null {
  const nextId = opts.nextId ?? generateId;
  const targetId = opts.targetId ?? pasteTarget(state);

  if (source.kind === "branch") {
    const node = source.node ?? state.document.clipboard;
    if (!node) return null;
    return [
      // `node` present = the clipboard's own subtree; absent = the internal
      // branch clipboard (the reducer reads it and clones with fresh ids), so
      // the pasted node's id is only known afterwards: flash the active one.
      { kind: "dispatch", action: { type: "pasteBranch", node: source.node }, undoType: "paste-branch" },
      { kind: "flash", ids: "active" },
      { kind: "save" },
    ];
  }

  const nodes = pastedNodes(source, nextId);
  if (nodes.length === 0) return null;
  return [
    { kind: "dispatch", action: { type: "insertNodes", targetId, nodes }, undoType: "paste" },
    { kind: "dispatch", action: { type: "exitEditing" } },
    { kind: "flash", ids: nodes.flatMap(subtreeIds) },
    { kind: "save" },
  ];
}

function pastedNodes(
  source: Exclude<PasteSource, { kind: "branch" }>,
  nextId: IdSource
): MindMapModel[] {
  if (source.kind === "text") {
    if (!source.text.trim()) return [];
    return textToNodes(source.text, nextId);
  }
  switch (source.mode) {
    case "decompose":
      return markdownToModel(source.text, nextId).children;
    case "node": {
      const text = source.text.trim();
      return text ? [{ id: nextId(), text, type: "markdown", children: [] }] : [];
    }
    case "plain":
      return textToNodes(source.text, nextId);
    default:
      return assertNever(source.mode);
  }
}

/** A clipboard event over a cross-node range, after its data has been read. */
export type RangeClipboardOp =
  | { kind: "copy" }
  | { kind: "cut" }
  /** `asNodes`: the view pastes this text as nodes (the outline's multi-line paste). */
  | { kind: "paste"; text: string; asNodes: boolean };

/**
 * A copy / cut / paste over a cross-node range (ViewState.textRange), or null
 * when there is no range and the event is the textarea's own. The textarea
 * holds only the anchor's part of a range, so the views hand every clipboard
 * event over one to this: `text` (when present) goes to the clipboard, then
 * the effects run.
 *
 * Cut deletes the range; paste replaces it with the pasted text in one step
 * (one undo entry) — or, where the view pastes text as nodes, deletes it and
 * pastes the nodes after the line it leaves. A paste with nothing in it
 * leaves the range alone.
 */
export function rangeClipboardCommand(
  state: EditorState,
  op: RangeClipboardOp,
  opts: { nextId?: IdSource } = {}
): { text?: string; effects: KeyEffect[] } | null {
  const range = state.view.textRange;
  if (!range) return null;
  const { model } = state.document;
  const replace = (text: string): KeyEffect => ({
    kind: "dispatch",
    action: { type: "replaceTextRange", text },
    undoType: "replace-range",
  });
  const save: KeyEffect = { kind: "save" };
  switch (op.kind) {
    case "copy":
    case "cut": {
      const text = rangeToPlainText(
        model,
        range,
        rangeTextOf(model, state.view.activeNodeId, state.view.editingText)
      );
      return { text, effects: op.kind === "cut" ? [replace(""), save] : [] };
    }
    case "paste": {
      if (!op.asNodes) return { effects: op.text ? [replace(op.text), save] : [] };
      const paste = pasteCommand(
        state,
        { kind: "text", text: op.text },
        { targetId: orderedRange(model, range).start.id, nextId: opts.nextId }
      );
      return { effects: paste ? [replace(""), ...paste] : [] };
    }
    default:
      return assertNever(op);
  }
}
