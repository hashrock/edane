import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { findNode } from "../domain/model";
import { editorReducer, type EditorState } from "./editorReducer";

/** Build a 4-ary tree (breadth-first) with `count` nodes. ids: n0..n{count-1}. */
function buildTree(count: number): MindMapModel {
  let i = 0;
  const make = (): MindMapModel => {
    const id = `n${i++}`;
    return { id, text: id, children: [] };
  };
  const root = make();
  const queue: MindMapModel[] = [root];
  while (i < count) {
    const parent = queue.shift()!;
    for (let b = 0; b < 4 && i < count; b++) {
      const child = make();
      parent.children.push(child);
      queue.push(child);
    }
  }
  return root;
}

function measureInsertMs(count: number, iterations: number): number {
  const model = buildTree(count);
  const targetId = `n${count - 1}`;
  const text = findNode(model, targetId)!.text;
  const state: EditorState = {
    model,
    activeNodeId: targetId,
    editing: true,
    editingText: text,
    cursorPos: text.length,
    selectionEnd: text.length,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
  };
  const action = {
    type: "typeText" as const,
    text: text + "x",
    cursorPos: text.length + 1,
    selectionEnd: text.length + 1,
    commitModel: true,
  };

  // warm up
  for (let n = 0; n < 20; n++) editorReducer(state, action);

  const start = performance.now();
  for (let n = 0; n < iterations; n++) editorReducer(state, action);
  return (performance.now() - start) / iterations;
}

describe("typeText insertion performance", () => {
  it("inserts a character into a 2000-node tree within budget", () => {
    const perInsert = measureInsertMs(2000, 200);
    // Informational: surfaces the actual cost when run with --reporter=verbose.
    console.log(
      `[perf] single-char insert, 2000-node tree: ${perInsert.toFixed(3)} ms`
    );
    // Generous ceiling — only trips on a catastrophic (e.g. O(n^2)) regression,
    // not on machine-to-machine noise. Typical value is well under 1 ms.
    expect(perInsert).toBeLessThan(20);
  });

  it("scales roughly linearly, not quadratically, with tree size", () => {
    const small = measureInsertMs(1000, 200);
    const large = measureInsertMs(4000, 100);
    // 4x the nodes should cost ~4x (linear clone). Allow 10x slack for noise;
    // a quadratic regression would be ~16x and trip this.
    expect(large).toBeLessThan(small * 10 + 1);
  });
});
