/**
 * Property-based tests for the read-only guard.
 *
 * 閲覧専用の保証は「編集UIを出さない」ではなく「dispatch が通さない」で
 * 成り立っている。つまり検証すべきは個々の画面ではなく、**任意のアクション列
 * に対して guardedStep が守る不変条件**そのもの。ここでは editorReducer の
 * プロパティテストと同じ生成器（`actionStepArb` / `resolveStep`、全
 * EditorAction 変種を網羅）で長さ25までの列を振り、
 *
 *   1. 決して編集モードに入らない
 *   2. 折りたたみ以外でモデルが変わらない（`collapsed` を剥がすと初期モデルに
 *      戻るという保存則）
 *   3. reducer 本来のフォーカス不変条件も壊れない
 *   4. `readOnly=false` では editorReducer そのもの（恒等性）
 *
 * を確かめる。3 が要るのは、遮断が「reducer の結果を捨てて prev を返す」実装
 * だから: 捨て方を間違えると文書とビューがずれた状態が残りうる。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { modelArb, sequentialIds, uncollapsed } from "../domain/model.arb";
import { editorReducer } from "./editorReducer";
import {
  actionStepArb,
  expectFocusInvariant,
  initialEditorState,
  resolveStep,
} from "./editorState.arb";
import { guardedStep } from "./readOnlyGuard";

describe("readOnly guard along random action sequences", () => {
  it("never enters edit mode and never changes the document except by collapsing", () => {
    fc.assert(
      fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
        let state = initialEditorState(model);
        const mint = sequentialIds("p");
        const nextId = sequentialIds();
        const trail: string[] = [];
        expect(state.view.editing).toBe(false);
        for (const step of steps) {
          const action = resolveStep(step, state, mint);
          trail.push(action.type);
          const prev = state;
          state = guardedStep(prev, action, true, nextId);
          const where = trail.join(" → ");
          expect(state.view.editing, `edit mode after ${where}`).toBe(false);
          if (state.document.model !== prev.document.model) {
            expect(action.type, `model changed by ${where}`).toBe("toggleCollapse");
          }
          if (state.document.clipboard !== prev.document.clipboard) {
            // コピーは読む操作なので通る。カットとペーストは木を変えるので
            // モデルごと弾かれ、クリップボードも動かない。`replace` は文書を
            // 丸ごと差し替えるアクションで、同じモデルを載せてくれば通る
            // （閲覧専用では undo スタックに何も積まれないので実際には来ない）。
            expect(["copyBranch", "replace"], `clipboard changed by ${where}`).toContain(
              action.type
            );
          }
          expectFocusInvariant(state, where);
        }
        // 保存則: 折りたたみ以外は一切通っていないので、`collapsed` を剥がせば
        // 最初のモデルに戻る。
        expect(uncollapsed(state.document.model)).toEqual(uncollapsed(model));
      }),
      { numRuns: 300 }
    );
  });

  it("is exactly editorReducer when not read-only", () => {
    fc.assert(
      fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
        let state = initialEditorState(model);
        const mint = sequentialIds("p");
        // 同じ手を2つの経路に流すので、id 供給も同じものを2本用意して並走させる。
        const guardedIds = sequentialIds();
        const plainIds = sequentialIds();
        for (const step of steps) {
          const action = resolveStep(step, state, mint);
          const guarded = guardedStep(state, action, false, guardedIds);
          expect(guarded).toEqual(editorReducer(state, action, plainIds));
          state = guarded;
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe("readOnly guard on the actions that would otherwise open the editor", () => {
  it("keeps the selection an activateNode asks for while dropping its editing flag", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), (model, n) => {
        const state = initialEditorState(model);
        const nodeId = model.children[n % model.children.length].id;
        const next = guardedStep(
          state,
          { type: "activateNode", nodeId, cursorPos: 0, selectionEnd: 0, editing: true },
          true
        );
        expect(next.view.activeNodeId).toBe(nodeId);
        expect(next.view.editing).toBe(false);
      })
    );
  });
});
