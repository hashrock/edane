/**
 * The plain-text reading of a document (application/textRange.ts), checked
 * over arbitrary trees: Shift+arrows walk it like a textarea's caret, and
 * copying a range spanning the whole document reads back (textToNodes) as
 * the same outline.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getFlatOrder, type MindMapDocument, type MindMapModel } from "../domain/model";
import { expectUniqueIds, modelArb, pick, sequentialIds, uncollapsedDocument } from "../domain/model.arb";
import { textToNodes } from "./persistence";
import { activeNode, runKeymap, type KeymapKeyEvent } from "./editorKeymap";
import { editorReducer } from "./editorReducer";
import { editorStateAt, keymapFor, layoutArb, prefsArb } from "./editorState.arb";
import {
  orderedRange,
  rangeTextOf,
  rangeToPlainText,
  replaceRange,
  stepPoint,
  type TextPoint,
  type VerticalMove,
} from "./textRange";

const lines: VerticalMove = (text, pos, dir) => {
  const parts = text.split("\n");
  let line = 0;
  let start = 0;
  while (line < parts.length - 1 && start + parts[line].length < pos) {
    start += parts[line].length + 1;
    line++;
  }
  const target = line + dir;
  if (target < 0 || target >= parts.length) return null;
  const col = pos - start;
  let targetStart = 0;
  for (let i = 0; i < target; i++) targetStart += parts[i].length + 1;
  return targetStart + Math.min(col, parts[target].length);
};

const textOf = (d: MindMapDocument) => rangeTextOf(d, null, "");

/** The shape of a forest: texts and nesting, no ids or attributes. */
type Shape = { text: string; children: Shape[] };
const shape = (n: MindMapModel): Shape => ({ text: n.text, children: n.children.map(shape) });

/** Texts that survive a plain-text line unchanged: one line, non-blank, trimmed. */
function asPlainLines(doc: MindMapDocument): MindMapDocument {
  const fix = (n: MindMapModel, i: number): MindMapModel => ({
    ...n,
    text: `${n.text.replace(/\s+/g, "") || "x"}${i}`,
    children: n.children.map(fix),
  });
  return { ...doc, roots: doc.roots.map(fix) };
}

describe("the plain-text reading", () => {
  it("Shift+→ from the very start visits every offset and stops at the very end", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const order = getFlatOrder(model);
        const t = textOf(model);
        const total = order.reduce((sum, id) => sum + t(id).length, 0) + order.length - 1;
        let p = { id: order[0], offset: 0 };
        for (let i = 0; i < total; i++) p = stepPoint(model, p, "right", t, lines);
        const last = order[order.length - 1];
        expect(p).toEqual({ id: last, offset: t(last).length });
        expect(stepPoint(model, p, "right", t, lines)).toEqual(p);
      })
    );
  });

  it("Shift+← undoes Shift+→ anywhere but the document's end", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (model, n, o) => {
        const id = pick(getFlatOrder(model), n);
        const t = textOf(model);
        const p = { id, offset: o % (t(id).length + 1) };
        const right = stepPoint(model, p, "right", t, lines);
        if (right.id === p.id && right.offset === p.offset) return; // the end
        expect(stepPoint(model, right, "left", t, lines)).toEqual(p);
      })
    );
  });

  it("copying the whole document pastes back as the same outline", () => {
    fc.assert(
      fc.property(modelArb, (generated) => {
        const model = asPlainLines(uncollapsedDocument(generated));
        const order = getFlatOrder(model);
        const last = order[order.length - 1];
        const text = rangeToPlainText(
          model,
          {
            anchor: { id: order[0], offset: 0 },
            focus: { id: last, offset: textOf(model)(last).length },
          },
          textOf(model)
        );
        expect(textToNodes(text, sequentialIds()).map(shape)).toEqual(model.roots.map(shape));
      })
    );
  });
});

/** The whole document as text (hidden subtrees too) and where each node's text starts in it. */
function fullText(doc: MindMapDocument): { text: string; startOf: Map<string, number> } {
  const lines: string[] = [];
  const startOf = new Map<string, number>();
  let at = 0;
  const walk = (n: MindMapModel, depth: number) => {
    const indent = "  ".repeat(depth);
    startOf.set(n.id, at + indent.length);
    lines.push(indent + n.text);
    at += indent.length + n.text.length + 1;
    n.children.forEach((c) => walk(c, depth + 1));
  };
  doc.roots.forEach((r) => walk(r, 0));
  return { text: lines.join("\n"), startOf };
}

describe("replacing a range is editing the plain text", () => {
  it("replaceRange ≡ replacing the same characters in the outline text and reading it back", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.stringMatching(/^[a-z]{0,3}$/),
        (generated, n1, o1, n2, o2, insert) => {
          const model = asPlainLines(generated);
          const order = getFlatOrder(model);
          const t = textOf(model);
          const point = (n: number, o: number): TextPoint => {
            const id = pick(order, n);
            return { id, offset: o % (t(id).length + 1) };
          };
          const range = { anchor: point(n1, o1), focus: point(n2, o2) };
          const { start, end } = orderedRange(model, range);
          const joined = t(start.id).slice(0, start.offset) + insert + t(end.id).slice(end.offset);
          fc.pre(joined !== ""); // a blank line reads back as no node at all

          const { doc, caret } = replaceRange(model, range, t, insert);
          const { text, startOf } = fullText(model);
          const a = startOf.get(start.id)! + start.offset;
          const b = startOf.get(end.id)! + end.offset;
          const edited = text.slice(0, a) + insert + text.slice(b);
          expect(doc.roots.map(shape)).toEqual(textToNodes(edited, sequentialIds()).map(shape));

          // Still a well-formed document; the caret sits after the insert.
          expectUniqueIds(doc);
          const nested = (n: MindMapModel): void =>
            n.children.forEach((c) => {
              expect(c.position).toBeUndefined();
              nested(c);
            });
          doc.roots.forEach(nested);
          expect(caret).toEqual({ id: start.id, offset: start.offset + insert.length });
          expect(getFlatOrder(doc)).toContain(start.id);
        }
      )
    );
  });
});

const shiftArrowArb: fc.Arbitrary<KeymapKeyEvent> = fc
  .constantFrom("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown")
  .map((key) => ({ key, shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }));

describe("a live range never traps the keyboard", () => {
  it("after any Shift+arrows, a plain arrow ends the range with the caret in a node", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        fc.nat(),
        prefsArb,
        layoutArb,
        fc.array(shiftArrowArb, { minLength: 1, maxLength: 12 }),
        fc.constantFrom("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"),
        (model, n, p, prefs, layout, shifts, plain) => {
          const bindings = keymapFor(prefs, layout);
          let state = editorStateAt(model, pick(getFlatOrder(model), n), { editing: true, pos: p });
          const press = (e: KeymapKeyEvent) => {
            const outcome = runKeymap(
              bindings,
              { e, state, node: activeNode(state), pos: state.view.cursorPos, selEnd: state.view.selectionEnd },
              prefs
            );
            for (const f of outcome.effects) {
              if (f.kind === "dispatch") state = editorReducer(state, f.action);
            }
            return outcome;
          };
          for (const e of shifts) press(e);
          if (!state.view.textRange) return; // never left the node
          // The anchor stays the node being edited, the textarea its part.
          expect(state.view.textRange.anchor.id).toBe(state.view.activeNodeId);
          const before = state.document;
          const outcome = press({ key: plain, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
          expect(outcome.result).toBe("handled");
          expect(state.document).toBe(before);
          expect(state.view.textRange).toBeUndefined();
          expect(state.view.editing).toBe(true);
          expect(getFlatOrder(state.document.model)).toContain(state.view.activeNodeId);
        }
      )
    );
  });
});
