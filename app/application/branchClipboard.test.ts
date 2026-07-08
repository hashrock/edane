import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { serializeBranch, parseBranch } from "./branchClipboard";

describe("serializeBranch / parseBranch round-trip", () => {
  it("preserves a well-formed branch's id, text, children and optional fields", () => {
    const branch: MindMapModel = {
      id: "n1",
      text: "Root",
      children: [
        {
          id: "n2",
          text: "https://example.com",
          type: "link",
          bold: true,
          fontSize: 20,
          collapsed: true,
          linkTitle: "Example",
          favicon: "https://example.com/f.ico",
          children: [],
        },
      ],
    };
    const parsed = parseBranch(serializeBranch(branch));
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("n1");
    expect(parsed!.children[0]).toMatchObject({
      id: "n2",
      type: "link",
      bold: true,
      fontSize: 20,
      collapsed: true,
      linkTitle: "Example",
      favicon: "https://example.com/f.ico",
    });
  });
});

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
    const collect = (m: MindMapModel): string[] => [
      m.id,
      ...m.children.flatMap(collect),
    ];
    const allIds = collect(parsed!);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
