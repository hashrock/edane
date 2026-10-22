import { describe, it, expect } from "vitest";
import { applyPatch, Conflict, diffDocument, type RoomRejection } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";
import { rejectionForAgent } from "./noteStore";

/** The message applyPatch gives a real same-field conflict. */
function conflictDetail(): string {
  const base: MindMapDocument = { title: "T", roots: [{ id: "r", text: "a", children: [] }] };
  const mine = diffDocument(base, { ...base, roots: [{ id: "r", text: "b", children: [] }] });
  const theirs = applyPatch(base, diffDocument(base, { ...base, roots: [{ id: "r", text: "c", children: [] }] }));
  try {
    applyPatch(theirs, mine);
  } catch (e) {
    if (e instanceof Conflict) return e.message;
  }
  throw new Error("expected a conflict");
}

describe("rejectionForAgent", () => {
  const detail = conflictDetail();
  const cases: [RoomRejection, RegExp | string][] = [
    [{ code: "conflict", detail }, detail],
    [{ code: "not-found" }, "Note not found: n1"],
    [{ code: "decrypt-failed" }, "Note could not be decrypted: n1"],
    [{ code: "too-large" }, /too large.*Split/],
    [{ code: "version-conflict" }, /Read the note again and retry/],
    [{ code: "operation-reused" }, /Read the note again and retry/],
    [{ code: "invalid-commit", detail: "Invalid field: text" }, /could not be applied: Invalid field: text/],
  ];
  it.each(cases)("words %o for the agent", (rejection, expected) => {
    const text = rejectionForAgent("n1", rejection);
    if (typeof expected === "string") expect(text).toBe(expected);
    else expect(text).toMatch(expected);
  });

  it("tells the agent to re-read on a merge conflict", () => {
    expect(rejectionForAgent("n1", { code: "conflict", detail })).toMatch(/retry/);
  });
});
