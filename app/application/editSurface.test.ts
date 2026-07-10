import { describe, it, expect } from "vitest";
import { EDIT_SURFACE, handleAuxInputKeys, type AuxKeyEvent } from "./editSurface";
import type { EditorAction, EditorState } from "./editorReducer";
import type { NodeType } from "../domain/model";

// A dispatch stub that records actions; the returned state is never inspected
// by handleAuxInputKeys, so a bare object cast is enough.
function recorder() {
  const actions: EditorAction[] = [];
  const dispatch = (action: EditorAction) => {
    actions.push(action);
    return {} as EditorState;
  };
  return { actions, dispatch };
}

function key(k: string, mods: Partial<AuxKeyEvent> = {}) {
  let prevented = false;
  const e: AuxKeyEvent & { prevented: () => boolean } = {
    key: k,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
    preventDefault: () => {
      prevented = true;
    },
    prevented: () => prevented,
  };
  return e;
}

describe("EDIT_SURFACE registry", () => {
  it("declares a surface for every layout × NodeType (compile-time via satisfies; sanity-check at runtime)", () => {
    const all: NodeType[] = ["text", "image", "link", "markdown", "object"];
    for (const layout of ["canvas", "outline"] as const) {
      for (const t of all) {
        expect(EDIT_SURFACE[layout][t].kind).toMatch(
          /^(keymap-textarea|aux-input|modal-panel)$/
        );
      }
    }
  });
});

describe("handleAuxInputKeys (keyboard-escape invariant for aux inputs)", () => {
  it("plain ArrowUp moves to the previous node", () => {
    const { actions, dispatch } = recorder();
    const e = key("ArrowUp");
    expect(handleAuxInputKeys(e, dispatch)).toBe("handled");
    expect(actions).toEqual([{ type: "moveUp" }]);
    expect(e.prevented()).toBe(true);
  });

  it("plain ArrowDown moves to the next node", () => {
    const { actions, dispatch } = recorder();
    const e = key("ArrowDown");
    expect(handleAuxInputKeys(e, dispatch)).toBe("handled");
    expect(actions).toEqual([{ type: "moveDown" }]);
    expect(e.prevented()).toBe(true);
  });

  it("Enter and Escape both exit editing", () => {
    for (const k of ["Enter", "Escape"]) {
      const { actions, dispatch } = recorder();
      expect(handleAuxInputKeys(key(k), dispatch)).toBe("handled");
      expect(actions).toEqual([{ type: "exitEditing" }]);
    }
  });

  it("modified arrows pass through (Alt reorders via keymap elsewhere; Cmd/Ctrl stay native)", () => {
    for (const mods of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      const { actions, dispatch } = recorder();
      const e = key("ArrowDown", mods);
      expect(handleAuxInputKeys(e, dispatch)).toBe("pass");
      expect(actions).toEqual([]);
      expect(e.prevented()).toBe(false);
    }
  });

  it("everything passes through while an IME composition is active", () => {
    for (const k of ["Enter", "Escape", "ArrowUp", "ArrowDown"]) {
      const { actions, dispatch } = recorder();
      const e = key(k, { nativeEvent: { isComposing: true } });
      expect(handleAuxInputKeys(e, dispatch)).toBe("pass");
      expect(actions).toEqual([]);
      expect(e.prevented()).toBe(false);
    }
  });

  it("horizontal arrows and typing pass through to the native input", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "a", "Backspace", "Tab"]) {
      const { actions, dispatch } = recorder();
      expect(handleAuxInputKeys(key(k), dispatch)).toBe("pass");
      expect(actions).toEqual([]);
    }
  });
});
