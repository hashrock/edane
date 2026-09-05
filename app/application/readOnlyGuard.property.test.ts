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
 *   3. クリップボードを動かせるのは copyBranch だけ
 *   4. reducer 本来のフォーカス不変条件も壊れない
 *   5. `readOnly=false` では editorReducer そのもの（恒等性）
 *
 * を確かめる。4 が要るのは、遮断が「reducer の結果を捨てて prev を返す」実装
 * だから: 捨て方を間違えると文書とビューがずれた状態が残りうる。
 *
 * さらに `READ_ONLY_ALLOWED`（人が書く宣言）と結果の検査（構造的な保証）が
 * 食い違っていないこと——**許可したアクションで結果の検査が一度も発動しない**
 * ——も確かめる。表が嘘をついた瞬間にここが落ちる。
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
import { guardedStep, isReadOnlyAllowed } from "./readOnlyGuard";

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
            // コピーだけが読む操作として通る。カットとペーストは木を変えるので
            // 宣言で弾かれ、`replace`（undo/redo の文書差し替え）も同様。
            expect(action.type, `clipboard changed by ${where}`).toBe("copyBranch");
          }
          // 弾かれたアクションは何一つ起こしていない（同一参照）。
          if (!isReadOnlyAllowed(action.type)) {
            expect(state, `disallowed ${action.type} changed state after ${where}`).toBe(prev);
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

describe("READ_ONLY_ALLOWED is an honest declaration", () => {
  it("never needs the result check: an allowed action never edits or opens the editor", () => {
    fc.assert(
      fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
        let state = initialEditorState(model);
        const mint = sequentialIds("p");
        const nextId = sequentialIds();
        for (const step of steps) {
          const action = resolveStep(step, state, mint);
          if (!isReadOnlyAllowed(action.type)) {
            // 宣言で弾かれる手は、状態を進めずに次の手へ（列は続ける）。
            continue;
          }
          // 許可した手を、結果の検査ぬきで（＝素の reducer で）走らせる。
          const stripped =
            action.type === "activateNode" && action.editing
              ? { ...action, editing: false }
              : action;
          const raw = editorReducer(state, stripped, nextId);
          expect(raw.view.editing, `allowed ${action.type} entered edit mode`).toBe(false);
          if (raw.document.model !== state.document.model) {
            expect(action.type, `allowed ${action.type} changed the model`).toBe("toggleCollapse");
          }
          // よって検査ありの guardedStep と結果が一致する。
          expect(guardedStep(state, action, true, sequentialIds())).toEqual(raw);
          state = raw;
        }
      }),
      { numRuns: 300 }
    );
  });

  it("is fail-closed for a type that is not in the table", () => {
    // 網羅とキーの妥当性は `satisfies` がコンパイル時に見る。実行時に効くのは
    // 「表に無いものを通さない」ことだけ——素の添字なら `Object.prototype` の
    // メンバが truthy を返して通ってしまう。
    expect(isReadOnlyAllowed("constructor")).toBe(false);
    expect(isReadOnlyAllowed("nope")).toBe(false);
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
