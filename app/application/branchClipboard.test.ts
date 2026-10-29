import { describe, it, expect } from "vitest";
import { subtreeIds } from "../domain/model";
import { parseBranch, parseBranches, serializeBranches } from "./branchClipboard";

describe("parseBranch with malformed payloads", () => {
  it("returns null for non-JSON or non-object input", () => {
    expect(parseBranch("not json")).toBeNull();
    expect(parseBranch(JSON.stringify(42))).toBeNull();
    expect(parseBranch("")).toBeNull();
  });

  it("returns null when the root lacks text or a children array", () => {
    expect(parseBranch(JSON.stringify({ id: "a" }))).toBeNull();
    expect(
      parseBranch(JSON.stringify({ id: "a", text: "t" }))
    ).toBeNull();
  });

  it("drops a malformed descendant instead of rejecting the whole branch", () => {
    // A single bad child used to fail `.every(...)` and reject the entire
    // payload, silently falling through to the Markdown/plain-text paste path
    // for what was otherwise a legitimate edane branch.
    const json = JSON.stringify({
      id: "root",
      text: "Root",
      children: [
        { id: "ok", text: "OK", children: [] },
        { id: "bad", text: "missing children" },
      ],
    });
    const parsed = parseBranch(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.children.map((c) => c.text)).toEqual(["OK"]);
  });

  it("drops a node's `type` when it is not one of the known kinds", () => {
    // Without field-level validation, an arbitrary string here would ride
    // straight into the model and stay attached to the node indefinitely.
    const json = JSON.stringify({
      id: "root",
      text: "Root",
      type: "not-a-real-kind",
      children: [],
    });
    const parsed = parseBranch(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBeUndefined();
  });

  it("drops a non-number `fontSize` instead of letting it reach layout/measurement", () => {
    const json = JSON.stringify({
      id: "root",
      text: "Root",
      fontSize: "huge",
      children: [],
    });
    const parsed = parseBranch(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.fontSize).toBeUndefined();
  });

  it("reassigns duplicated ids so the pasted branch is a unique-id tree", () => {
    const json = JSON.stringify({
      id: "dup",
      text: "Root",
      children: [
        { id: "dup", text: "A", children: [] },
        { id: "dup", text: "B", children: [] },
      ],
    });
    const parsed = parseBranch(json);
    expect(parsed).not.toBeNull();
    const allIds = subtreeIds(parsed!);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe("several branches (a copied multi-selection)", () => {
  it("round-trip as an array, in order", () => {
    const a = { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] };
    const b = { id: "b", text: "B", children: [] };
    expect(parseBranches(serializeBranches([a, b]))).toEqual([a, b]);
    // One branch stays a plain node, readable by parseBranch as before.
    expect(parseBranch(serializeBranches([b]))).toEqual(b);
  });

  it("keep ids unique across branches, and reject a payload with a bad entry", () => {
    const parsed = parseBranches(JSON.stringify([{ id: "x", text: "1", children: [] }, { id: "x", text: "2", children: [] }]))!;
    expect(parsed.map((n) => n.text)).toEqual(["1", "2"]);
    expect(parsed[0].id).not.toBe(parsed[1].id);
    expect(parseBranches(JSON.stringify([{ id: "x", text: "1", children: [] }, 42]))).toBeNull();
    expect(parseBranches("[]")).toBeNull();
  });
});
