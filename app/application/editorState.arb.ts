/**
 * Test-only helpers for property tests over EditorState (application layer,
 * next to the reducer, since the domain layer can't know EditorState). The
 * companion of domain/model.arb.ts. Not imported by production code.
 */
import { expect } from "vitest";
import fc from "fast-check";
import {
  findNode,
  findParentAndIndex,
  visibleChildrenOf,
  type MindMapModel,
} from "../domain/model";
import type { EditorState } from "./editorReducer";
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
