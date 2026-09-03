/**
 * Whole-keymap robustness: for ANY key event — every key the keymap knows
 * about and some it doesn't, under every modifier combination — pressed in
 * any state under any preferences and layout, the effects the keymap asks
 * for must keep the editor's focus invariant (the active node exists and is
 * visible, a top-level node remains, ids stay unique), and the effect list
 * itself must be well-formed (a "pass" carries no effects; "save" only ever
 * follows a dispatch that could have changed something).
 *
 * editorKeymap.property.test.ts pins down what specific arrows DO; this file
 * only says what no key may ever do, but says it for the whole keyboard and
 * along sequences of key presses, so a binding added later is covered
 * without a test of its own.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getFlatOrder } from "../domain/model";
import { modelArb, pick, sequentialIds } from "../domain/model.arb";
import { activeNode, runKeymap, type KeymapKeyEvent } from "./editorKeymap";
import { editorReducer } from "./editorReducer";
import {
  editorStateAt,
  expectFocusInvariant,
  keymapFor,
  layoutArb,
  prefsArb,
} from "./editorState.arb";

// Every key a binding matches on, plus a few plain characters and keys no
// binding wants — the keymap must be indifferent to those.
const KEYS = [
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Enter", "Tab", "Backspace", "Delete", "Escape", " ", "F2",
  "?", "k", "z", "Z", "y", "/", "b", "d", ".", "a", "Home", "PageDown",
];

const keyEventArb: fc.Arbitrary<KeymapKeyEvent> = fc.record({
  key: fc.constantFrom(...KEYS),
  metaKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  shiftKey: fc.boolean(),
  altKey: fc.boolean(),
});

describe("any key, any state: the keymap never breaks the focus invariant", () => {
  it("along sequences of key presses under every preference and layout", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        fc.boolean(),
        fc.nat(),
        prefsArb,
        layoutArb,
        fc.array(keyEventArb, { minLength: 1, maxLength: 15 }),
        (model, n, editing, p, prefs, layout, keys) => {
          const bindings = keymapFor(prefs, layout);
          const nextId = sequentialIds();
          let state = editorStateAt(model, pick(getFlatOrder(model), n), { editing, pos: p });
          const trail: string[] = [];
          for (const e of keys) {
            const mods = [e.metaKey && "meta", e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(Boolean).join("+");
            trail.push(mods ? `${mods}+${e.key}` : e.key);
            const outcome = runKeymap(
              bindings,
              { e, state, node: activeNode(state), pos: state.view.cursorPos, selEnd: state.view.selectionEnd },
              prefs
            );
            // Well-formed effect list.
            if (outcome.result === "pass") {
              expect(outcome.effects, `pass with effects on ${trail.join(" ")}`).toEqual([]);
            }
            let dispatched = false;
            for (const f of outcome.effects) {
              if (f.kind === "save") expect(dispatched, `save before any dispatch on ${trail.join(" ")}`).toBe(true);
              if (f.kind !== "dispatch") continue;
              dispatched = true;
              state = editorReducer(state, f.action, nextId);
              expectFocusInvariant(state, `${trail.join(" ")} [${f.action.type}]`);
            }
          }
        }
      ),
      { numRuns: 400 }
    );
  });
});
