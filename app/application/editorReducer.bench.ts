import { bench, describe } from "vitest";
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
  const BRANCH = 4;
  while (i < count) {
    const parent = queue.shift()!;
    for (let b = 0; b < BRANCH && i < count; b++) {
      const child = make();
      parent.children.push(child);
      queue.push(child);
    }
  }
  return root;
}

/** State editing the last (deepest-created) node — worst case for findNode. */
function stateForTree(model: MindMapModel, count: number): EditorState {
  const targetId = `n${count - 1}`;
  const text = findNode(model, targetId)!.text;
  return {
    model,
    activeNodeId: targetId,
    editing: true,
    editingText: text,
    cursorPos: text.length,
    selectionEnd: text.length,
    clipboard: null,
  };
}

// How long does inserting a single character take as the tree grows?
// typeText commits to the model, which clones the whole tree (O(n)).
for (const count of [100, 500, 1000, 5000, 10000]) {
  describe(`insert one character into a ${count}-node tree`, () => {
    const model = buildTree(count);
    const state = stateForTree(model, count);
    const text = state.editingText;

    bench("typeText", () => {
      editorReducer(state, {
        type: "typeText",
        text: text + "x",
        cursorPos: text.length + 1,
        selectionEnd: text.length + 1,
        commitModel: true,
      });
    });
  });
}
