import { describe, it, expect } from "vitest";
import { applyPatch, diffDocument } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";
import { commitRejection } from "./noteStore";

describe("commitRejection", () => {
  it("passes a merge conflict through with its retry hint", () => {
    const base: MindMapDocument = { title: "T", roots: [{ id: "r", text: "a", children: [] }] };
    const mine = diffDocument(base, { ...base, roots: [{ id: "r", text: "b", children: [] }] });
    const theirs = applyPatch(base, diffDocument(base, { ...base, roots: [{ id: "r", text: "c", children: [] }] }));
    const message = (() => {
      try {
        applyPatch(theirs, mine);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("expected a conflict");
    })();
    expect(commitRejection("n1", message)).toBe(message);
    expect(message).toMatch(/retry/);
  });

  it("rewords the room's expected rejections for an agent", () => {
    expect(commitRejection("n1", "Note changed or was deleted; reconnect")).toMatch(/Read the note again and retry/);
    expect(commitRejection("n1", "Note unavailable")).toBe("Note not found: n1");
    expect(commitRejection("n1", "Commit exceeds 1 MB")).toMatch(/too large/);
  });

  it("keeps anything else an internal error", () => {
    expect(commitRejection("n1", "D1_ERROR: database is locked")).toBeNull();
    expect(commitRejection("n1", "Invalid field: text")).toBeNull();
  });
});
