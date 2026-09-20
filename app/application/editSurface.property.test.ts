/**
 * `handleAuxInputKeys` is the single enforcement point CLAUDE.md names for the
 * `aux-input` surface of the keyboard-escape invariant, but editSurface.test.ts
 * only exercises it against one fixed URL string and a handful of hand-picked
 * caret positions. Since the function is pure — (value, caret) -> handled |
 * pass — its edge arithmetic is directly PBT-able the same way
 * editorKeymap.property.test.ts already proves the keymap-textarea surface.
 * This file total-enumerates arbitrary text and caret positions instead.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { handleAuxInputKeys, type AuxKeyEvent } from "./editSurface";
import type { EditorAction, EditorState } from "./editorReducer";

function recorder() {
  const actions: EditorAction[] = [];
  const dispatch = (action: EditorAction) => {
    actions.push(action);
    return {} as EditorState;
  };
  return { actions, dispatch };
}

function key(k: string, currentTarget: AuxKeyEvent["currentTarget"]): AuxKeyEvent {
  return {
    key: k,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    currentTarget,
    preventDefault: () => {},
  };
}

describe("handleAuxInputKeys: keyboard-escape invariant over arbitrary text/caret", () => {
  it("plain ArrowUp/ArrowDown always cross to the neighbour node, at any caret in any text", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.nat(),
        fc.constantFrom("ArrowUp", "ArrowDown"),
        (value, n, k) => {
          const pos = n % (value.length + 1);
          const { actions, dispatch } = recorder();
          const e = key(k, { value, selectionStart: pos, selectionEnd: pos });
          expect(handleAuxInputKeys(e, dispatch)).toBe("handled");
          expect(actions).toEqual([{ type: k === "ArrowUp" ? "moveUp" : "moveDown" }]);
        }
      )
    );
  });

  it("plain ArrowLeft/ArrowRight with no selection: handled exactly at the edge the key faces, native pass otherwise", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.nat(),
        fc.constantFrom("ArrowLeft", "ArrowRight"),
        (value, n, k) => {
          const pos = n % (value.length + 1);
          const { actions, dispatch } = recorder();
          const e = key(k, { value, selectionStart: pos, selectionEnd: pos });
          const result = handleAuxInputKeys(e, dispatch);
          const atEdge =
            (k === "ArrowLeft" && pos === 0) || (k === "ArrowRight" && pos === value.length);
          if (atEdge) {
            expect(result).toBe("handled");
            expect(actions).toEqual([
              { type: k === "ArrowLeft" ? "arrowLeftEdge" : "arrowRightEdge" },
            ]);
          } else {
            expect(result).toBe("pass");
            expect(actions).toEqual([]);
          }
        }
      )
    );
  });

  it("a non-empty range selection always passes (it collapses natively first, crosses on the next press)", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.nat(),
        fc.nat(),
        fc.constantFrom("ArrowLeft", "ArrowRight"),
        (value, a, b, k) => {
          const len = value.length;
          fc.pre(len > 0);
          const start = a % (len + 1);
          const end = b % (len + 1);
          fc.pre(start !== end);
          const { actions, dispatch } = recorder();
          const e = key(k, { value, selectionStart: start, selectionEnd: end });
          expect(handleAuxInputKeys(e, dispatch)).toBe("pass");
          expect(actions).toEqual([]);
        }
      )
    );
  });

  it("an unreadable caret (null selection) always escapes rather than risking a trap, for any text", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("ArrowLeft", "ArrowRight"), (value, k) => {
        const { actions, dispatch } = recorder();
        const e = key(k, { value, selectionStart: null, selectionEnd: null });
        expect(handleAuxInputKeys(e, dispatch)).toBe("handled");
        expect(actions).toEqual([
          { type: k === "ArrowLeft" ? "arrowLeftEdge" : "arrowRightEdge" },
        ]);
      })
    );
  });
});
