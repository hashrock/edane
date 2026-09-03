/**
 * Model-based test: editorReducer against a deliberately naive reference.
 *
 * The reference keeps the document as a flat outline — one row per node with
 * its depth, in DFS order — and implements the structural keyboard edits,
 * the line joins (Backspace at the start, Delete at the end), Enter at any
 * caret position, sibling-first navigation and the enter/leave-edit-mode
 * transitions (including the blank-leaf cleanup) directly on that list
 * (indent = "the block gets one deeper", dedent = "the block moves after the
 * parent's block, one shallower", …). It is simpler
 * than the tree code by construction and shares nothing with it, so any
 * disagreement is a real question about the intended rule.
 *
 * Ids are supplied from outside (`sequentialIds`), which is what makes an
 * exact comparison possible: both sides mint ids in the same situations, so
 * the rows must match id for id. Collapsing is out of scope here (the trees
 * are generated without it and none of these actions fold anything).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { topLevelNodes, type IdSource, type MindMapModel } from "../domain/model";
import { modelArb, sequentialIds } from "../domain/model.arb";
import { editorReducer, type EditorAction, type EditorState } from "./editorReducer";
import { editorStateAt } from "./editorState.arb";

// --- The reference: a flat outline ---

interface Row {
  id: string;
  depth: number;
  text: string;
}
interface Ref {
  rows: Row[];
  active: string;
  editing: boolean;
}

/** Index just past the subtree that starts at `i`. */
function subtreeEnd(rows: Row[], i: number): number {
  let j = i + 1;
  while (j < rows.length && rows[j].depth > rows[i].depth) j++;
  return j;
}
function parentOf(rows: Row[], i: number): number | null {
  for (let k = i - 1; k >= 0; k--) if (rows[k].depth === rows[i].depth - 1) return k;
  return null;
}
function prevSibling(rows: Row[], i: number): number | null {
  for (let k = i - 1; k >= 0; k--) {
    if (rows[k].depth < rows[i].depth) return null;
    if (rows[k].depth === rows[i].depth) return k;
  }
  return null;
}
function nextSibling(rows: Row[], i: number): number | null {
  const j = subtreeEnd(rows, i);
  return j < rows.length && rows[j].depth === rows[i].depth ? j : null;
}
const shift = (block: Row[], by: number): Row[] =>
  block.map((r) => ({ ...r, depth: r.depth + by }));

type RefAction =
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "moveNodeUp" }
  | { kind: "moveNodeDown" }
  | { kind: "indent" }
  | { kind: "dedent" }
  | { kind: "enter"; pos: number }
  | { kind: "insertSiblingAfter" }
  | { kind: "backspaceAtStart" }
  | { kind: "deleteAtEnd" }
  | { kind: "deleteNode"; row: number }
  | { kind: "moveToParent" }
  | { kind: "moveUpSiblingFirst" }
  | { kind: "moveDownSiblingFirst" }
  | { kind: "startEditing" }
  | { kind: "exitEditing" };

function refStep(ref: Ref, action: RefAction, nextId: IdSource): Ref {
  const rows = ref.rows.map((r) => ({ ...r }));
  const i = rows.findIndex((r) => r.id === ref.active);
  let { active, editing } = ref;
  const j = subtreeEnd(rows, i);
  const block = rows.slice(i, j);

  switch (action.kind) {
    case "moveUp":
      if (i > 0) active = rows[i - 1].id;
      return { rows, active, editing };
    case "moveDown":
      if (i < rows.length - 1) active = rows[i + 1].id;
      return { rows, active, editing };

    case "moveNodeUp": {
      const p = prevSibling(rows, i);
      if (p === null) return ref;
      const prevBlock = rows.slice(p, i);
      rows.splice(p, j - p, ...block, ...prevBlock);
      return { rows, active, editing };
    }
    case "moveNodeDown": {
      const s = nextSibling(rows, i);
      if (s === null) return ref;
      const e = subtreeEnd(rows, s);
      rows.splice(i, e - i, ...rows.slice(s, e), ...block);
      return { rows, active, editing };
    }

    case "indent": {
      // Becoming the previous sibling's last child changes nothing in DFS
      // order: the block already follows that sibling's subtree.
      if (prevSibling(rows, i) === null) return ref;
      rows.splice(i, j - i, ...shift(block, 1));
      return { rows, active, editing };
    }
    case "dedent": {
      const k = parentOf(rows, i);
      if (k === null) return ref; // a tree root has no parent to leave
      const e = subtreeEnd(rows, k);
      // After the parent's whole subtree, one level up; later siblings stay.
      rows.splice(i, e - i, ...rows.slice(j, e), ...shift(block, -1));
      return { rows, active, editing };
    }

    case "insertSiblingAfter": {
      // A tree root takes the new node as a child (no new trees by typing).
      const depth = rows[i].depth === 0 ? 1 : rows[i].depth;
      const id = nextId();
      rows.splice(j, 0, { id, depth, text: "" });
      return { rows, active: id, editing: true };
    }
    case "enter": {
      const top = rows[i].depth === 0;
      const depth = top ? 1 : rows[i].depth;
      const id = nextId();
      const text = rows[i].text;
      // "At the end" is checked first, so on an empty node Enter always
      // creates the node BELOW (an empty node has no "above" to split off).
      if (action.pos >= text.length) {
        // Blank node after the whole subtree (a tree root: as its last child).
        rows.splice(j, 0, { id, depth, text: "" });
        return { rows, active: id, editing };
      }
      if (action.pos <= 0) {
        // An empty line ABOVE: before the node (a tree root: as its first
        // child); the node keeps its id, text and children, and the focus.
        rows.splice(top ? i + 1 : i, 0, { id, depth, text: "" });
        return { rows, active, editing };
      }
      // Split: the suffix becomes the next sibling (a tree root: first child);
      // children stay with the prefix.
      rows[i].text = text.slice(0, action.pos);
      rows.splice(top ? i + 1 : j, 0, { id, depth, text: text.slice(action.pos) });
      return { rows, active: id, editing };
    }
    case "deleteAtEnd": {
      // Pull the structural successor up: the first child (its children take
      // its slot, one level up), else the next sibling (its children become
      // trailing children of this node, keeping their depth).
      const child = i + 1 < j;
      const s = child ? i + 1 : nextSibling(rows, i);
      if (s === null) return ref;
      const e = subtreeEnd(rows, s);
      rows[i].text += rows[s].text;
      rows.splice(s, e - s, ...shift(rows.slice(s + 1, e), child ? -1 : 0));
      return { rows, active, editing };
    }
    case "moveToParent": {
      const k = parentOf(rows, i);
      return k === null ? ref : { rows, active: rows[k].id, editing };
    }
    case "moveUpSiblingFirst": {
      const p = prevSibling(rows, i);
      if (p !== null) return { rows, active: rows[p].id, editing };
      const k = parentOf(rows, i);
      return k === null ? ref : { rows, active: rows[k].id, editing };
    }
    case "moveDownSiblingFirst": {
      // The next sibling, else the first ancestor's next sibling: never a child.
      for (let k: number | null = i; k !== null; k = parentOf(rows, k)) {
        const s = nextSibling(rows, k);
        if (s !== null) return { rows, active: rows[s].id, editing };
      }
      return ref;
    }
    case "startEditing":
      return { rows, active, editing: true };
    case "exitEditing": {
      if (!editing) return ref;
      const onlyTopLevel = rows[i].depth === 0 && rows.filter((r) => r.depth === 0).length === 1;
      const blankLeaf = rows[i].text.trim() === "" && j === i + 1;
      if (!blankLeaf || onlyTopLevel) return { rows, active, editing: false };
      // Leaving a blank leaf deletes it; land on the previous row, else the first.
      rows.splice(i, 1);
      return { rows, active: i > 0 ? rows[i - 1].id : rows[0].id, editing: false };
    }

    case "backspaceAtStart": {
      const p = prevSibling(rows, i);
      if (p !== null) {
        // The node's children trail the sibling's own: dropping the row is
        // enough, they already sit right after the sibling's subtree.
        rows[p].text += rows[i].text;
        rows.splice(i, 1);
        return { rows, active: rows[p].id, editing };
      }
      const k = parentOf(rows, i);
      if (k === null) return ref; // first tree root: nothing before it
      rows[k].text += rows[i].text;
      rows.splice(i, j - i, ...shift(block.slice(1), -1)); // children take its slot
      return { rows, active: rows[k].id, editing };
    }

    case "deleteNode": {
      const r = action.row;
      const re = subtreeEnd(rows, r);
      const activeInside = i >= r && i < re;
      rows.splice(r, re - r);
      if (rows.length === 0) {
        const id = nextId();
        return { rows: [{ id, depth: 0, text: "" }], active: id, editing };
      }
      if (activeInside) active = r > 0 ? rows[r - 1].id : rows[0].id;
      return { rows, active, editing };
    }
  }
}

// --- Bridging to the real reducer ---

function toRows(model: MindMapModel): Row[] {
  const out: Row[] = [];
  const walk = (n: MindMapModel, depth: number) => {
    out.push({ id: n.id, depth, text: n.text });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const top of topLevelNodes(model)) walk(top, 0);
  return out;
}

function toAction(action: RefAction, state: EditorState, ref: Ref): EditorAction {
  switch (action.kind) {
    case "indent":
      return { type: "tab", shift: false };
    case "dedent":
      return { type: "tab", shift: true };
    case "enter":
      return { type: "enter", pos: action.pos };
    case "deleteAtEnd": {
      const row = ref.rows.find((r) => r.id === state.view.activeNodeId)!;
      return { type: "deleteAtEnd", pos: row.text.length };
    }
    case "deleteNode":
      return { type: "deleteNode", nodeId: ref.rows[action.row].id };
    default:
      return { type: action.kind };
  }
}

const KINDS: RefAction["kind"][] = [
  "moveUp",
  "moveDown",
  "moveNodeUp",
  "moveNodeDown",
  "indent",
  "dedent",
  "enter",
  "insertSiblingAfter",
  "backspaceAtStart",
  "deleteAtEnd",
  "deleteNode",
  "moveToParent",
  "moveUpSiblingFirst",
  "moveDownSiblingFirst",
  "startEditing",
  "exitEditing",
];
const stepArb = fc.record({ kind: fc.constantFrom(...KINDS), n: fc.nat() });

const uncollapsed = (n: MindMapModel): MindMapModel => {
  const { collapsed: _c, ...rest } = n;
  return { ...rest, children: n.children.map(uncollapsed) };
};
const openModelArb = modelArb.map(uncollapsed);

describe("editorReducer vs. flat-outline reference", () => {
  it("agrees on rows, active node and edit mode after every structural keyboard edit", () => {
    fc.assert(
      fc.property(openModelArb, fc.array(stepArb, { maxLength: 30 }), (model, steps) => {
        const first = model.children[0];
        let state: EditorState = editorStateAt(model, first.id);
        let ref: Ref = { rows: toRows(model), active: first.id, editing: false };
        const reducerIds = sequentialIds();
        const refIds = sequentialIds();
        const trail: string[] = [];

        for (const s of steps) {
          const activeRow = ref.rows.find((r) => r.id === ref.active)!;
          const action: RefAction =
            s.kind === "deleteNode"
              ? { kind: "deleteNode", row: s.n % ref.rows.length }
              : s.kind === "enter"
                ? { kind: "enter", pos: s.n % (activeRow.text.length + 1) }
                : { kind: s.kind };
          trail.push(action.kind);
          state = editorReducer(state, toAction(action, state, ref), reducerIds);
          ref = refStep(ref, action, refIds);
          const where = trail.join(" → ");
          expect(toRows(state.document.model), where).toEqual(ref.rows);
          expect(state.view.activeNodeId, where).toBe(ref.active);
          expect(state.view.editing, where).toBe(ref.editing);
        }
      }),
      { numRuns: 300 }
    );
  });
});
