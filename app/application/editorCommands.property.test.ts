/**
 * `pasteCommand` turns a decoded clipboard payload into a `KeyEffect[]`, and
 * unlike `planPaste` (pastePlan.property.test.ts) it had no test of its own —
 * only indirect coverage through editorReducer.property.test.ts, which only
 * ever exercises the "text" branch. This file total-enumerates `PasteSource`
 * (a discriminated union) and checks the invariants every branch must share:
 * null exactly when there is nothing to paste, and — when non-null — an
 * effect list shaped the way editorReducer.property.test.ts and the paste
 * handlers in MindmapEditor/OutlineEditor assume (ends with save, flashes
 * exactly what was inserted).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { pasteCommand, type PasteSource } from "./editorCommands";
import { markdownToModel } from "./markdown";
import { subtreeIds, firstRootId, type MindMapModel } from "../domain/model";
import type { EditorAction } from "./editorReducer";
import type { KeyEffect } from "./editorKeymap";
import { branchPasteSourceArb, editorStateAt } from "./editorState.arb";
import { modelAndVisibleArb, modelArb, sequentialIds } from "../domain/model.arb";

const modelAndTargetArb = modelAndVisibleArb.map(({ model, nodeId }) => ({
  state: editorStateAt(model, nodeId),
  targetId: nodeId,
}));

const textSourceArb = fc
  .string({ maxLength: 20 })
  .map((text) => ({ kind: "text" as const, text }));

/** All three `mode`s, for tests that only care about the shared effect shape. */
const markdownSourceArb = fc
  .tuple(
    fc.string({ maxLength: 20 }),
    fc.constantFrom("decompose" as const, "node" as const, "plain" as const)
  )
  .map(([text, mode]) => ({ kind: "markdown" as const, text, mode }));

/**
 * `"node"` / `"plain"`, whose empty-input rule is the same one-line trim
 * `pasteCommand` itself applies — unlike `"decompose"` (see below), asserting
 * that rule here doesn't require re-running a parser as an oracle.
 */
const trivialMarkdownSourceArb = fc
  .tuple(fc.string({ maxLength: 20 }), fc.constantFrom("node" as const, "plain" as const))
  .map(([text, mode]) => ({ kind: "markdown" as const, text, mode }));

/** Whether `source` (independent of any state) carries anything to paste. */
function hasContent(source: PasteSource, clipboard: MindMapModel | null): boolean {
  switch (source.kind) {
    case "text":
      return source.text.trim() !== "";
    case "markdown":
      if (source.mode === "decompose") {
        return markdownToModel(source.text, sequentialIds("probe")).children.length > 0;
      }
      return source.text.trim() !== "";
    case "branch":
      return (source.node ?? clipboard) != null;
  }
}

/**
 * Narrow a `pasteCommand` result to its `insertNodes` dispatch (the first
 * effect of every node-inserting paste), or fail with a clear message.
 * Shared by every test below that needs the inserted nodes, so the narrowing
 * is written once instead of copy-pasted at each call site.
 */
function unwrapInsertNodes(effects: KeyEffect[] | null): {
  effects: KeyEffect[];
  action: Extract<EditorAction, { type: "insertNodes" }>;
} {
  const insert = effects?.[0];
  if (!effects || !insert || insert.kind !== "dispatch" || insert.action.type !== "insertNodes") {
    throw new Error("expected an insertNodes dispatch as the first effect");
  }
  return { effects, action: insert.action };
}

describe("pasteCommand: null exactly when there is nothing to paste", () => {
  it("over text / node / plain / branch sources and an arbitrary target state", () => {
    fc.assert(
      fc.property(
        modelAndTargetArb,
        fc.oneof(textSourceArb, trivialMarkdownSourceArb, branchPasteSourceArb),
        ({ state, targetId }, source) => {
          const result = pasteCommand(state, source, {
            targetId,
            nextId: sequentialIds("new"),
          });
          expect(result !== null).toBe(hasContent(source, state.document.clipboard));
        }
      )
    );
  });
});

describe("pasteCommand: decompose paste's blank-input rule", () => {
  // "x " guarantees a non-blank, non-heading, non-list, non-rule line, so
  // markdownToModel's plain-paragraph fallthrough always emits >=1 child —
  // asserted directly against pasteCommand's own result, rather than by
  // recomputing markdownToModel as an oracle (which the "decompose" case of
  // hasContent above does, and which a bug in markdownToModel itself could
  // never fail: both sides would be wrong the same way).
  const nonBlankMarkdownArb = fc.string({ maxLength: 10 }).map((s) => `x ${s}`);
  const blankMarkdownArb = fc
    .array(fc.constantFrom("", "   ", "\t"), { maxLength: 5 })
    .map((lines) => lines.join("\n"));

  it("is null when the markdown is blank", () => {
    fc.assert(
      fc.property(modelAndTargetArb, blankMarkdownArb, ({ state, targetId }, text) => {
        const effects = pasteCommand(
          state,
          { kind: "markdown", text, mode: "decompose" },
          { targetId, nextId: sequentialIds("new") }
        );
        expect(effects).toBeNull();
      })
    );
  });

  it("is non-null once at least one line has real content", () => {
    fc.assert(
      fc.property(modelAndTargetArb, nonBlankMarkdownArb, ({ state, targetId }, text) => {
        const effects = pasteCommand(
          state,
          { kind: "markdown", text, mode: "decompose" },
          { targetId, nextId: sequentialIds("new") }
        );
        expect(effects).not.toBeNull();
      })
    );
  });
});

describe("pasteCommand: effect list shape when there IS something to paste", () => {
  it("node-inserting sources (text / markdown) end with save and flash exactly the inserted subtree", () => {
    fc.assert(
      fc.property(
        modelAndTargetArb,
        fc.oneof(textSourceArb, markdownSourceArb),
        ({ state, targetId }, source) => {
          // Checked before calling pasteCommand (unlike checking the result
          // for null afterwards) so a source with nothing to paste never
          // pays for the real textToNodes/markdownToModel parse.
          fc.pre(hasContent(source, null));
          const { effects, action: insertAction } = unwrapInsertNodes(
            pasteCommand(state, source, { targetId, nextId: sequentialIds("new") })
          );
          expect(effects).toHaveLength(4);
          const [, exit, flash, save] = effects;

          expect(insertAction.targetId).toBe(targetId);
          expect(insertAction.nodes.length).toBeGreaterThan(0);

          expect(exit).toEqual({ kind: "dispatch", action: { type: "exitEditing" } });

          const expectedFlashIds = insertAction.nodes.flatMap(subtreeIds);
          expect(flash).toEqual({ kind: "flash", ids: expectedFlashIds });

          expect(save).toEqual({ kind: "save" });
        }
      )
    );
  });

  it("branch sources dispatch pasteBranch with the given node (or none) and flash the active node", () => {
    fc.assert(
      fc.property(modelAndTargetArb, branchPasteSourceArb, ({ state, targetId }, source) => {
        fc.pre(hasContent(source, state.document.clipboard));
        const effects = pasteCommand(state, source, {
          targetId,
          nextId: sequentialIds("new"),
        });
        expect(effects).toEqual([
          {
            kind: "dispatch",
            action: { type: "pasteBranch", node: source.node },
            undoType: "paste-branch",
          },
          { kind: "flash", ids: "active" },
          { kind: "save" },
        ]);
      })
    );
  });
});

describe("pasteCommand: target resolution", () => {
  it("falls back to the active node when no explicit targetId is given", () => {
    fc.assert(
      fc.property(modelAndTargetArb, fc.string({ maxLength: 5 }), ({ state, targetId }, text) => {
        fc.pre(text.trim() !== "");
        const { action } = unwrapInsertNodes(
          pasteCommand(state, { kind: "text", text }, { nextId: sequentialIds("new") })
        );
        expect(action.targetId).toBe(targetId);
      })
    );
  });

  it("falls back to the first root when neither an explicit targetId nor an active node exists", () => {
    fc.assert(
      fc.property(modelArb, fc.string({ maxLength: 5 }), (model, text) => {
        fc.pre(text.trim() !== "");
        const state = editorStateAt(model, firstRootId(model));
        const noActive = { ...state, view: { ...state.view, activeNodeId: null } };
        const { action } = unwrapInsertNodes(
          pasteCommand(noActive, { kind: "text", text }, { nextId: sequentialIds("new") })
        );
        expect(action.targetId).toBe(firstRootId(model));
      })
    );
  });
});
