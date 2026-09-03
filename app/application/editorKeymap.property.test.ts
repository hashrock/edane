/**
 * The keyboard-escape invariant of CLAUDE.md, checked headlessly.
 *
 * Because the keymap is pure (a key resolves to a list of effects), the
 * dispatch effects can be fed straight into editorReducer: for any tree, any
 * visible node, any caret position and any layout, an unmodified arrow key
 * while editing must either move the caret within the node or move to the
 * neighbouring node — never be swallowed with nothing happening. The only
 * allowed stop is the document's own edge (nothing above the first node,
 * nothing below the last). Mid-text ←/→ are left to the textarea, which is
 * itself a caret move, so those must come back as "pass" with no effects.
 *
 * Selection mode is checked the same way for both `arrowBehavior` settings
 * and both layouts: ↑/↓ pick the layout's action and only dead-end on the
 * tree's edge; → descends (expanding first) or, under "collapse", folds and
 * unfolds; ← climbs or folds. A fold/unfold is always followed by a save.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  findNode,
  findParentAndIndex,
  getFlatOrder,
  isTopLevel,
  updateNodeText,
} from "../domain/model";
import { modelAndVisibleArb, modelArb, pick } from "../domain/model.arb";
import {
  activeNode,
  runKeymap,
  type KeyEffect,
  type KeymapKeyEvent,
} from "./editorKeymap";
import { editorReducer, type EditorState } from "./editorReducer";
import { DEFAULT_PREFERENCES, type EditorPreferences } from "./editorPreferences";
import type { EditorLayout } from "./editSurface";
import {
  arrowBehaviorArb,
  editorStateAt,
  keymapFor,
  layoutArb,
  onTrailingEdge,
} from "./editorState.arb";
// The keymap's default verticalMove breaks on hard newlines only (Infinity
// width cap) and runs headless, so the test can use it both to drive the
// keymap and to predict where ↑/↓ should land.
import { verticalMove } from "../lib/textGeometry";

const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
type Arrow = (typeof ARROWS)[number];
const plain = (key: Arrow): KeymapKeyEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
});

const multiLineArb = fc
  .array(fc.string({ maxLength: 4 }), { minLength: 1, maxLength: 3 })
  .map((lines) => lines.join("\n"));

function press(
  state: EditorState,
  key: Arrow,
  pos: number,
  prefs: EditorPreferences,
  layout: EditorLayout
) {
  const outcome = runKeymap(
    keymapFor(prefs, layout),
    { e: plain(key), state, node: activeNode(state), pos, selEnd: pos },
    prefs
  );
  // Arrow keys only ever navigate or fold: nothing else may leak in.
  for (const f of outcome.effects) {
    expect(["dispatch", "save"], `effect ${f.kind} on ${key}`).toContain(f.kind);
  }
  const next = outcome.effects.reduce<EditorState>(
    (s, f: KeyEffect) => (f.kind === "dispatch" ? editorReducer(s, f.action) : s),
    state
  );
  return { outcome, next };
}

describe("editing mode: unmodified arrows always move the caret or the node", () => {
  it("↑ ↓ ← → on any node, at any caret position, in either layout", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        multiLineArb,
        fc.nat(),
        fc.constantFrom(...ARROWS),
        layoutArb,
        arrowBehaviorArb,
        (base, n, text, p, key, layout, arrowBehavior) => {
          const nodeId = pick(getFlatOrder(base), n);
          const model = updateNodeText(base, nodeId, text);
          const pos = p % (text.length + 1);
          const state = editorStateAt(model, nodeId, { editing: true, pos });
          const prefs = { ...DEFAULT_PREFERENCES, arrowBehavior };
          const { outcome, next } = press(state, key, pos, prefs, layout);
          const order = getFlatOrder(model);
          const idx = order.indexOf(nodeId);

          // Native caret move: the keymap must get out of the way entirely.
          const native =
            (key === "ArrowLeft" && pos > 0) ||
            (key === "ArrowRight" && pos < text.length);
          if (native) {
            expect(outcome.result).toBe("pass");
            expect(outcome.effects).toEqual([]);
            return;
          }
          expect(outcome.result).toBe("handled");

          const dir = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
          const withinNode =
            (key === "ArrowUp" || key === "ArrowDown") && verticalMove(text, pos, dir) !== null;
          if (withinNode) {
            expect(next.view.activeNodeId).toBe(nodeId);
            expect(next.view.cursorPos).not.toBe(pos);
            return;
          }
          const neighbour = order[idx + dir];
          if (neighbour === undefined) {
            // The document's edge: the one place an arrow may stop.
            expect(next.view.activeNodeId).toBe(nodeId);
            return;
          }
          expect(next.view.activeNodeId).toBe(neighbour);
        }
      ),
      { numRuns: 400 }
    );
  });
});

describe("selection mode: arrows navigate or fold, for both arrowBehavior settings and both layouts", () => {
  it("↑/↓ use the layout's action and only dead-end on the tree's edge", () => {
    fc.assert(
      fc.property(
        modelAndVisibleArb,
        fc.constantFrom<Arrow>("ArrowUp", "ArrowDown"),
        layoutArb,
        arrowBehaviorArb,
        ({ model, nodeId }, key, layout, arrowBehavior) => {
          const prefs = { ...DEFAULT_PREFERENCES, arrowBehavior };
          const { outcome, next } = press(editorStateAt(model, nodeId), key, 0, prefs, layout);
          expect(outcome.result).toBe("handled");
          const up = key === "ArrowUp";
          const expectedAction =
            layout === "canvas"
              ? up ? "moveUpSiblingFirst" : "moveDownSiblingFirst"
              : up ? "moveUp" : "moveDown";
          expect(outcome.effects).toEqual([
            { kind: "dispatch", action: { type: expectedAction }, undoType: undefined },
          ]);

          const order = getFlatOrder(model);
          const idx = order.indexOf(nodeId);
          const info = findParentAndIndex(model, nodeId)!;
          const stuck =
            layout === "canvas"
              ? up
                ? isTopLevel(model, nodeId) && info.index === 0
                : onTrailingEdge(model, nodeId)
              : up
                ? idx === 0
                : idx === order.length - 1;
          expect(next.view.activeNodeId !== nodeId).toBe(!stuck);
        }
      )
    );
  });

  it("→ descends (unfolding first) or, under 'collapse', unfolds; ← climbs or folds", () => {
    fc.assert(
      fc.property(
        modelAndVisibleArb,
        fc.constantFrom<Arrow>("ArrowLeft", "ArrowRight"),
        layoutArb,
        arrowBehaviorArb,
        ({ model, nodeId }, key, layout, arrowBehavior) => {
          const node = findNode(model, nodeId)!;
          const prefs = { ...DEFAULT_PREFERENCES, arrowBehavior };
          const { outcome, next } = press(editorStateAt(model, nodeId), key, 0, prefs, layout);
          expect(outcome.result).toBe("handled");

          const folded = outcome.effects.some(
            (f) => f.kind === "dispatch" && f.action.type === "toggleCollapse"
          );
          // Every fold/unfold persists; nothing else does.
          expect(outcome.effects.some((f) => f.kind === "save")).toBe(folded);

          const hasChildren = node.children.length > 0;
          const nextNode = findNode(next.document.model, nodeId)!;
          const landedOnChild =
            next.view.activeNodeId !== nodeId &&
            findParentAndIndex(next.document.model, next.view.activeNodeId!)!.parent.id === nodeId;

          if (key === "ArrowRight") {
            if (!hasChildren) {
              expect(outcome.effects).toEqual([]);
              return;
            }
            if (arrowBehavior === "navigate") {
              expect(folded).toBe(node.collapsed === true);
              expect(nextNode.collapsed).not.toBe(true);
              expect(landedOnChild).toBe(true);
            } else if (node.collapsed) {
              expect(folded).toBe(true);
              expect(nextNode.collapsed).toBe(false);
              expect(next.view.activeNodeId).toBe(nodeId);
            } else {
              expect(folded).toBe(false);
              expect(landedOnChild).toBe(true);
            }
            return;
          }

          // ArrowLeft
          const parentId = findParentAndIndex(model, nodeId)!.parent.id;
          const climbsTo = isTopLevel(model, nodeId) ? nodeId : parentId;
          if (arrowBehavior === "collapse" && hasChildren && !node.collapsed) {
            expect(folded).toBe(true);
            expect(nextNode.collapsed).toBe(true);
            expect(next.view.activeNodeId).toBe(nodeId);
          } else {
            expect(folded).toBe(false);
            expect(next.view.activeNodeId).toBe(climbsTo);
          }
        }
      )
    );
  });
});
