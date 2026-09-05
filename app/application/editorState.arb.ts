/**
 * Test-only helpers for property tests over EditorState (application layer,
 * next to the reducer, since the domain layer can't know EditorState). The
 * companion of domain/model.arb.ts. Not imported by production code.
 */
import { expect } from "vitest";
import fc from "fast-check";
import {
  cloneWithNewIds,
  findNode,
  findParentAndIndex,
  firstNavigableId,
  getFlatOrder,
  NODE_TYPES,
  visibleChildrenOf,
  type IdSource,
  type MindMapModel,
} from "../domain/model";
import { modelArb, nodeArb, nodeIds, pick } from "../domain/model.arb";
import { assertNever } from "../lib/assertNever";
import type { EditorAction, EditorState } from "./editorReducer";
import { buildKeymap, type KeyBinding } from "./editorKeymap";
import {
  ARROW_BEHAVIORS,
  ENTER_BEHAVIORS,
  TAB_BEHAVIORS,
  type EditorPreferences,
} from "./editorPreferences";
import type { EditorLayout } from "./editSurface";

/**
 * An editor state with `nodeId` active. `pos` may be any natural (an
 * `fc.nat()`): it is reduced modulo the text length + 1, so every caret
 * position is reachable and shrinks toward the start.
 */
export function editorStateAt(
  model: MindMapModel,
  nodeId: string,
  opts: { editing?: boolean; pos?: number } = {}
): EditorState {
  const text = findNode(model, nodeId)?.text ?? "";
  const pos = (opts.pos ?? 0) % (text.length + 1);
  return {
    document: { model, clipboard: null },
    view: {
      activeNodeId: nodeId,
      editing: opts.editing ?? false,
      editingText: text,
      cursorPos: pos,
      selectionEnd: pos,
      lastChildByParent: {},
    },
  };
}

/**
 * The state a session starts in: the first navigable node selected, nothing
 * being edited — what `useNoteEditor` builds on mount. The seed for every
 * action-sequence property, so the machines driven by the same sequences all
 * start from the same place.
 */
export function initialEditorState(model: MindMapModel): EditorState {
  return editorStateAt(model, firstNavigableId(model));
}

/**
 * The editor's standing invariant, checked after any action: ids unique; a
 * top-level node exists; the active node is set, is not the (invisible) root
 * and is visible (no collapsed ancestor); nested nodes carry no canvas
 * position; while editing (and the buffer matches the model), the caret stays
 * within the edited text. One DFS collects everything.
 */
export function expectFocusInvariant(state: EditorState, trail: string): void {
  const { model } = state.document;
  const ids = new Set<string>();
  let count = 0;
  const visible = new Set<string>();
  const walk = (n: MindMapModel, nested: boolean, shown: boolean) => {
    ids.add(n.id);
    count++;
    if (shown) visible.add(n.id);
    if (nested) expect(n.position, `nested position after ${trail}`).toBeUndefined();
    const vis = visibleChildrenOf(n);
    for (const c of n.children) walk(c, true, shown && vis.kind === "recurse");
  };
  for (const top of model.children) walk(top, false, true);
  expect(ids.size, `unique ids after ${trail}`).toBe(count);
  expect(model.children.length, `top-level node after ${trail}`).toBeGreaterThan(0);
  const active = state.view.activeNodeId;
  expect(active, `active node after ${trail}`).not.toBeNull();
  expect(active, `active is root after ${trail}`).not.toBe(model.id);
  expect(visible.has(active!), `active visible after ${trail}`).toBe(true);
  // Mid-IME the buffer runs ahead of the model (typeText with
  // commitModel=false), and caret actions are defined against the committed
  // text; the bound only holds once the two agree.
  const committed = findNode(model, active!)?.text;
  if (state.view.editing && committed === state.view.editingText) {
    const len = state.view.editingText.length;
    expect(state.view.cursorPos, `caret after ${trail}`).toBeLessThanOrEqual(len);
    expect(state.view.selectionEnd, `selection after ${trail}`).toBeLessThanOrEqual(len);
  }
}

/** Is the node on the tree's trailing edge (last child of a last child … of the last top-level node)? */
export function onTrailingEdge(model: MindMapModel, nodeId: string): boolean {
  for (let info = findParentAndIndex(model, nodeId); info; info = findParentAndIndex(model, info.parent.id)) {
    if (info.index !== info.parent.children.length - 1) return false;
  }
  return true;
}

export const layoutArb = fc.constantFrom<EditorLayout>("canvas", "outline");
export const arrowBehaviorArb = fc.constantFrom(...ARROW_BEHAVIORS);
export const prefsArb: fc.Arbitrary<EditorPreferences> = fc.record({
  selectionMode: fc.boolean(),
  tabBehavior: fc.constantFrom(...TAB_BEHAVIORS),
  enterBehavior: fc.constantFrom(...ENTER_BEHAVIORS),
  arrowBehavior: arrowBehaviorArb,
});

/** buildKeymap is pure in (prefs, layout); build each combination once. */
const keymaps = new Map<string, KeyBinding[]>();
export function keymapFor(prefs: EditorPreferences, layout: EditorLayout): KeyBinding[] {
  const key = `${JSON.stringify(prefs)}|${layout}`;
  let bindings = keymaps.get(key);
  if (!bindings) {
    bindings = buildKeymap(prefs, layout);
    keymaps.set(key, bindings);
  }
  return bindings;
}

// --- Random action sequences ---

/**
 * Every EditorAction variant. `satisfies` keeps this exhaustive: a new variant
 * fails to compile here (and in {@link resolveStep} below) until the sequence
 * generator knows how to produce it.
 */
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
export interface ActionStep {
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
/**
 * A random action, drawn independently of any state: node ids and caret
 * positions are unbounded naturals resolved against the live state by
 * {@link resolveStep}, so every step of a generated sequence is meaningful
 * whatever the preceding steps did to the tree.
 */
export const actionStepArb: fc.Arbitrary<ActionStep> = fc
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
export function resolveStep(step: ActionStep, state: EditorState, mint: IdSource): EditorAction {
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
