/**
 * Property-based tests for editorReducer.
 *
 * 1. The focus invariant — "exactly ONE node is always active" (module doc
 *    of editorReducer.ts): the active node always exists and is visible, and
 *    the document always has a top-level node — checked along RANDOM action
 *    sequences on random trees, one entry per EditorAction variant. A step's
 *    node/position arguments are drawn as unbounded naturals and resolved
 *    against the current state, so every generated sequence is meaningful.
 *
 * 2. The canvas ↑/↓ rule from CLAUDE.md: a dead end depends only on where the
 *    node sits in the tree (the trailing edge for ↓, the first top-level node
 *    for ↑), never on history; ↓ never descends into children; and ← / →
 *    round-trip through the parent.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  cloneWithNewIds,
  findNode,
  findParentAndIndex,
  getFlatOrder,
  isTopLevel,
  NODE_TYPES,
  type IdSource,
  type MindMapModel,
} from "../domain/model";
import {
  modelAndVisibleArb,
  modelArb,
  nodeArb,
  nodeIds,
  pick,
  sequentialIds,
} from "../domain/model.arb";
import { pasteCommand, type PasteSource } from "./editorCommands";
import {
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editorReducer";
import { assertNever } from "../lib/assertNever";
import { editorStateAt, expectFocusInvariant, onTrailingEdge } from "./editorState.arb";

// `satisfies` keeps this exhaustive: a new EditorAction variant fails to
// compile here (and in `resolve` below) until the sequence generator knows
// how to produce it.
const KINDS = {
  enter: true,
  tab: true,
  backspaceAtStart: true,
  deleteAtEnd: true,
  moveNodeUp: true,
  moveNodeDown: true,
  moveBranch: true,
  placeBranchAt: true,
  addRootAt: true,
  moveUp: true,
  moveDown: true,
  moveUpSiblingFirst: true,
  moveDownSiblingFirst: true,
  moveToParent: true,
  cmdLeft: true,
  cmdRight: true,
  cmdShiftLeft: true,
  cmdShiftRight: true,
  arrowLeftEdge: true,
  arrowRightEdge: true,
  moveToChild: true,
  typeText: true,
  setSelection: true,
  copyBranch: true,
  cutBranch: true,
  pasteBranch: true,
  activateNode: true,
  selectAllInNode: true,
  startEditing: true,
  exitEditing: true,
  dragSelect: true,
  insertSiblingAfter: true,
  toggleCollapse: true,
  addChild: true,
  deleteNode: true,
  setNodeType: true,
  setNodeContent: true,
  setNodeStyle: true,
  setLinkMeta: true,
  setChecked: true,
  insertNodes: true,
  setTitle: true,
  replace: true,
} satisfies Record<EditorAction["type"], true>;
type Kind = keyof typeof KINDS;

/** An action with its node/position choices still abstract (naturals). */
interface Step {
  kind: Kind;
  a: number;
  b: number;
  c: number;
  text: string;
  flag: boolean;
  /** A subtree entering from outside (paste / insert); drawn only for those kinds. */
  branch: MindMapModel;
  /** A whole other document (undo/redo swap); drawn only for `replace`. */
  model: MindMapModel;
}

// The kinds that bring a tree with them draw one; every other kind shares a
// fixed placeholder, so a 25-step sequence doesn't generate (and shrink) 50
// trees nobody reads.
const NEEDS_BRANCH: Kind[] = ["pasteBranch", "insertNodes"];
const NEEDS_MODEL: Kind[] = ["replace"];
const PLACEHOLDER: MindMapModel = { id: "placeholder", text: "", children: [] };
const stepArb: fc.Arbitrary<Step> = fc
  .constantFrom(...(Object.keys(KINDS) as Kind[]))
  .chain((kind) =>
    fc.record({
      kind: fc.constant(kind),
      a: fc.nat(),
      b: fc.nat(),
      c: fc.nat(),
      text: fc.string({ maxLength: 6 }),
      flag: fc.boolean(),
      branch: NEEDS_BRANCH.includes(kind) ? nodeArb : fc.constant(PLACEHOLDER),
      model: NEEDS_MODEL.includes(kind) ? modelArb : fc.constant(PLACEHOLDER),
    })
  );

/** `mint` supplies ids for branches that enter from outside (paste, undo). */
function resolve(step: Step, state: EditorState, mint: IdSource): EditorAction {
  const { kind, a, b, c, text, flag } = step;
  const model = state.document.model;
  // Pointer / context-menu / DnD actions can only ever target a VISIBLE node;
  // asynchronous completions (link metadata, uploads) and undo may name any.
  const vis = (n: number) => pick(getFlatOrder(model), n);
  const id = (n: number) => pick(nodeIds(model), n);
  const textOf = (nodeId: string | null) =>
    nodeId ? (findNode(model, nodeId)?.text ?? "") : "";
  // Caret positions come from the textarea, whose value is the live
  // editingText while editing (it may run ahead of the model mid-IME).
  const activeText = state.view.editing
    ? state.view.editingText
    : textOf(state.view.activeNodeId);
  const pos = (n: number, t = activeText) => n % (t.length + 1);
  switch (kind) {
    case "enter":
    case "deleteAtEnd":
    case "cmdLeft":
    case "cmdRight":
      return { type: kind, pos: pos(a) };
    case "cmdShiftLeft":
    case "cmdShiftRight":
      return { type: kind, pos: pos(a), selEnd: pos(b) };
    case "tab":
      return { type: kind, shift: flag };
    case "backspaceAtStart":
    case "moveNodeUp":
    case "moveNodeDown":
    case "moveUp":
    case "moveDown":
    case "moveUpSiblingFirst":
    case "moveDownSiblingFirst":
    case "moveToParent":
    case "moveToChild":
    case "arrowLeftEdge":
    case "arrowRightEdge":
    case "copyBranch":
    case "cutBranch":
    case "startEditing":
    case "exitEditing":
    case "insertSiblingAfter":
      return { type: kind };
    case "moveBranch":
      return {
        type: kind,
        nodeId: vis(a),
        newParentId: flag ? model.id : vis(b),
        index: c % 6 === 0 ? undefined : (c % 6) - 1,
      };
    case "placeBranchAt":
      return { type: kind, nodeId: vis(a), x: b % 2000, y: c % 2000 };
    case "addRootAt":
      return { type: kind, x: b % 2000, y: c % 2000 };
    case "typeText":
      return {
        type: kind,
        text,
        cursorPos: pos(a, text),
        selectionEnd: pos(b, text),
        commitModel: flag,
      };
    case "setSelection":
      return { type: kind, cursorPos: pos(a), selectionEnd: pos(b) };
    case "pasteBranch":
      return flag ? { type: kind } : { type: kind, node: cloneWithNewIds(step.branch, mint) };
    case "activateNode": {
      const nodeId = vis(a);
      const t = textOf(nodeId);
      return { type: kind, nodeId, cursorPos: pos(b, t), selectionEnd: pos(c, t), editing: flag };
    }
    case "selectAllInNode":
    case "toggleCollapse":
    case "addChild":
    case "deleteNode":
      return { type: kind, nodeId: vis(a) };
    case "dragSelect": {
      const nodeId = vis(a);
      const t = textOf(nodeId);
      return { type: kind, nodeId, anchorOffset: pos(b, t), focusOffset: pos(c, t) };
    }
    case "setNodeType":
      return { type: kind, nodeId: vis(a), nodeType: pick(NODE_TYPES, b) };
    case "setNodeContent":
      return {
        type: kind,
        nodeId: id(a),
        text,
        nodeType: flag ? pick(NODE_TYPES, b) : undefined,
      };
    case "setNodeStyle":
      return {
        type: kind,
        nodeId: vis(a),
        fontSize: flag ? null : 8 + (b % 40),
        bold: c % 2 === 0,
      };
    case "setLinkMeta":
      return { type: kind, nodeId: id(a), linkTitle: text, favicon: flag ? null : "f.ico" };
    case "setChecked":
      return { type: kind, nodeId: vis(a), checked: flag ? null : c % 2 === 0 };
    case "insertNodes":
      return { type: kind, targetId: vis(a), nodes: [cloneWithNewIds(step.branch, mint)] };
    case "setTitle":
      return { type: kind, text };
    case "replace": {
      // Undo/redo: the document is swapped, the view is whatever it was. Half
      // the time the view points at a node of the SAME document (possibly one
      // that is now hidden), half the time at a document that no longer has
      // it at all.
      const nextModel = flag ? model : cloneWithNewIds(step.model, mint);
      const view = flag
        ? { ...state.view, activeNodeId: id(b) }
        : state.view;
      return {
        type: kind,
        state: { document: { model: nextModel, clipboard: null }, view },
      };
    }
    default:
      return assertNever(kind);
  }
}

const initialState = (model: MindMapModel): EditorState =>
  editorStateAt(model, model.children[0].id);

describe("editorReducer along random action sequences", () => {
  it("keeps the active node existing & visible, ids unique and a top-level node present — and is a pure function of its inputs", () => {
    fc.assert(
      fc.property(modelArb, fc.array(stepArb, { maxLength: 25 }), (model, steps) => {
        // With ids supplied from outside the whole run is deterministic, so
        // running it twice must end in the same state: the reducer keeps no
        // hidden state and never depends on anything but its arguments. The
        // invariant is checked on the first pass only.
        const run = (check: boolean): EditorState => {
          let state = initialState(model);
          const nextId = sequentialIds();
          const mint = sequentialIds("p");
          const trail: string[] = [];
          if (check) expectFocusInvariant(state, "init");
          for (const step of steps) {
            const action = resolve(step, state, mint);
            trail.push(action.type);
            state = editorReducer(state, action, nextId);
            if (check) expectFocusInvariant(state, trail.join(" → "));
          }
          return state;
        };
        const first = run(true);
        expect(run(false)).toEqual(first);
      }),
      { numRuns: 300 }
    );
  });
});

function selecting(model: MindMapModel, nodeId: string): EditorState {
  const s = initialState(model);
  return editorReducer(s, {
    type: "activateNode",
    nodeId,
    cursorPos: 0,
    selectionEnd: 0,
    editing: false,
  });
}

describe("selection-mode ↑/↓ (sibling-first) is decided by tree position only", () => {
  it("↓ dead-ends exactly on the trailing edge, otherwise lands outside the subtree on the next sibling-or-ancestor's-sibling", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        const state = selecting(model, nodeId);
        const next = editorReducer(state, { type: "moveDownSiblingFirst" });
        const stuck = next.view.activeNodeId === nodeId;
        expect(stuck).toBe(onTrailingEdge(model, nodeId));
        if (stuck) return;
        const landed = next.view.activeNodeId!;
        // Never a descendant …
        expect(findNode(findNode(model, nodeId)!, landed)).toBeNull();
        // … and exactly the first following sibling found walking up.
        let expected: string | undefined;
        for (let info = findParentAndIndex(model, nodeId); info && !expected; info = findParentAndIndex(model, info.parent.id)) {
          expected = info.parent.children[info.index + 1]?.id;
        }
        expect(landed).toBe(expected);
      })
    );
  });

  it("↑ dead-ends only on the first top-level node, otherwise lands on the previous sibling or the parent", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        const state = selecting(model, nodeId);
        const next = editorReducer(state, { type: "moveUpSiblingFirst" });
        const info = findParentAndIndex(model, nodeId)!;
        const stuck = next.view.activeNodeId === nodeId;
        expect(stuck).toBe(isTopLevel(model, nodeId) && info.index === 0);
        if (stuck) return;
        const expected = info.index > 0 ? info.parent.children[info.index - 1].id : info.parent.id;
        expect(next.view.activeNodeId).toBe(expected);
      })
    );
  });

  it("← then → returns to the node you left (for any nested visible node)", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        fc.pre(!isTopLevel(model, nodeId));
        const state = selecting(model, nodeId);
        const up = editorReducer(state, { type: "moveToParent" });
        expect(up.view.activeNodeId).toBe(findParentAndIndex(model, nodeId)!.parent.id);
        const back = editorReducer(up, { type: "moveToChild" });
        expect(back.view.activeNodeId).toBe(nodeId);
      })
    );
  });
});

// --- Commands: the real multi-step sequences the components run ---

/** An outline-ish plain text: lines with 0–2 levels of indentation. */
const indentedTextArb = fc
  .array(fc.tuple(fc.nat({ max: 2 }), fc.string({ maxLength: 6 })), { maxLength: 4 })
  .map((ls) => ls.map(([d, t]) => "  ".repeat(d) + t).join("\n"));

/** A small Markdown document: bullets at 0–2 levels, some as tasks. */
const markdownArb = fc
  .array(
    fc.tuple(fc.nat({ max: 2 }), fc.constantFrom("", "[ ] ", "[x] "), fc.stringMatching(/^[a-z0-9 ]{0,6}$/)),
    { maxLength: 4 }
  )
  .map((ls) => ls.map(([d, box, t]) => `${"  ".repeat(d)}- ${box}${t}`).join("\n"));

const pasteSourceArb: fc.Arbitrary<PasteSource> = fc.oneof(
  indentedTextArb.map((text) => ({ kind: "text", text }) as PasteSource),
  fc
    .tuple(markdownArb, fc.constantFrom("decompose", "node", "plain") as fc.Arbitrary<"decompose" | "node" | "plain">)
    .map(([text, mode]) => ({ kind: "markdown", text, mode }) as PasteSource),
  fc.option(nodeArb, { nil: undefined }).map((node) => ({ kind: "branch", node }) as PasteSource)
);

type SeqStep = { kind: "action"; step: Step } | { kind: "paste"; source: PasteSource };
const seqStepArb: fc.Arbitrary<SeqStep> = fc.oneof(
  stepArb.map((step) => ({ kind: "action", step }) as SeqStep),
  pasteSourceArb.map((source) => ({ kind: "paste", source }) as SeqStep)
);

describe("paste commands interleaved with actions", () => {
  it("keep the focus invariant at every step, end in selection mode, and every pasted node is visible", () => {
    fc.assert(
      fc.property(modelArb, fc.array(seqStepArb, { maxLength: 20 }), (model, steps) => {
        let state = initialState(model);
        const nextId = sequentialIds();
        const mint = sequentialIds("p");
        const trail: string[] = [];
        for (const s of steps) {
          if (s.kind === "action") {
            const action = resolve(s.step, state, mint);
            trail.push(action.type);
            state = editorReducer(state, action, nextId);
            expectFocusInvariant(state, trail.join(" → "));
            continue;
          }
          // Node pastes only happen in selection mode (planPaste turns a paste
          // while editing into plain text at the caret), so the sequence is
          // only meaningful there.
          if (state.view.editing) continue;
          const effects = pasteCommand(state, s.source, { nextId: mint });
          trail.push(`paste:${s.source.kind}`);
          // null = nothing to paste (blank text, empty internal clipboard).
          if (!effects) continue;
          let flashed: string[] | "active" = [];
          for (const f of effects) {
            if (f.kind === "flash") flashed = f.ids;
            if (f.kind !== "dispatch") continue;
            state = editorReducer(state, f.action, nextId);
            expectFocusInvariant(state, trail.join(" → ") + ` [${f.action.type}]`);
          }
          const visible = getFlatOrder(state.document.model);
          if (flashed !== "active") {
            expect(state.view.editing, `edit mode after ${trail.join(" → ")}`).toBe(false);
            for (const id of flashed) {
              expect(visible, `pasted node hidden after ${trail.join(" → ")}`).toContain(id);
            }
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});
