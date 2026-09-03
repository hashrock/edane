/**
 * Property-based tests for the serialization boundary: whatever the domain
 * produces must survive the trip through JSON (the DB / API / clipboard
 * payload), and whatever comes back from that boundary — including garbage —
 * must be normalized into a well-formed unique-id tree.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isStoredNodeType, type MindMapModel } from "../domain/model";
import { allIds, expectUniqueIds, modelArb, nodeArb, sequentialIds } from "../domain/model.arb";
import {
  modelToText,
  normalizeTree,
  parseContent,
  serializeModel,
  textToModel,
} from "./persistence";
import { parseBranch, serializeBranch } from "./branchClipboard";

function expectWellFormed(node: MindMapModel) {
  expectUniqueIds(node);
  const walk = (n: MindMapModel) => {
    expect(typeof n.id).toBe("string");
    expect(n.id).not.toBe("");
    expect(typeof n.text).toBe("string");
    expect(Array.isArray(n.children)).toBe(true);
    if ("collapsed" in n) expect(n.collapsed).toBe(true);
    if ("bold" in n) expect(n.bold).toBe(true);
    if ("type" in n) expect(isStoredNodeType(n.type)).toBe(true);
    if ("fontSize" in n) expect(typeof n.fontSize).toBe("number");
    if ("linkTitle" in n) expect(typeof n.linkTitle).toBe("string");
    if ("favicon" in n) expect(typeof n.favicon).toBe("string");
    if ("checked" in n) expect(typeof n.checked).toBe("boolean");
    if ("position" in n) {
      expect(Number.isFinite(n.position!.x)).toBe(true);
      expect(Number.isFinite(n.position!.y)).toBe(true);
    }
    n.children.forEach(walk);
  };
  walk(node);
}

describe("JSON round trips", () => {
  it("parseContent(serializeModel(m)) === m for every well-formed document", () => {
    fc.assert(
      fc.property(modelArb, fc.string(), (model, title) => {
        expect(parseContent(serializeModel(model), title)).toEqual(model);
      })
    );
  });

  it("parseBranch(serializeBranch(n)) === n for every well-formed branch", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(parseBranch(serializeBranch(node))).toEqual(node);
      })
    );
  });

  it("normalizeTree is idempotent", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const once = normalizeTree(JSON.parse(serializeModel(model)), new Set())!;
        expect(normalizeTree(once, new Set())).toEqual(once);
      })
    );
  });
});

describe("normalizeTree on untrusted input", () => {
  it("returns null or a well-formed tree for any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const out = normalizeTree(value, new Set());
        if (out !== null) expectWellFormed(out);
      })
    );
  });

  it("repairs duplicated / missing ids without touching the shape", () => {
    fc.assert(
      fc.property(modelArb, fc.constantFrom("dup", "", 42, null, undefined), (model, badId) => {
        const wreck = (n: MindMapModel): unknown => ({
          ...n,
          id: badId,
          children: n.children.map(wreck),
        });
        // A usable id survives on its first occurrence only; every later
        // duplicate (and every missing/malformed id) is minted afresh, parent
        // before children in DFS order. Nothing else changes.
        const next = sequentialIds();
        let first = true;
        const relabel = (n: MindMapModel): MindMapModel => {
          const keep = first && typeof badId === "string" && badId !== "";
          first = false;
          const id = keep ? badId : next();
          return { ...n, id, children: n.children.map(relabel) };
        };
        expect(normalizeTree(wreck(model), new Set(), sequentialIds())).toEqual(relabel(model));
      })
    );
  });

  it("parseContent always yields at least one top-level node", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), fc.string(), (content, title) => {
        expect(parseContent(content, title).children.length).toBeGreaterThan(0);
      })
    );
  });
});

describe("legacy indented text", () => {
  // The text format carries only text and nesting: one node per line, no
  // blank lines, no leading/trailing whitespace. Restrict the generator to
  // texts the format can represent.
  const lineText = fc
    .string({ minLength: 1, maxLength: 10 })
    .filter((s) => s.trim() === s && !s.includes("\n"));
  const plainModel = modelArb.chain((m) => {
    const texts = allIds(m).length;
    return fc.array(lineText, { minLength: texts, maxLength: texts }).map((ts) => {
      let i = 0;
      const relabel = (n: MindMapModel): MindMapModel => ({
        id: n.id,
        text: ts[i++],
        children: n.children.map(relabel),
      });
      return relabel(m);
    });
  });

  it("textToModel(modelToText) restores the tree shape (top-level nodes as lines at depth 0)", () => {
    fc.assert(
      fc.property(plainModel, (model) => {
        const text = model.children.map((c) => modelToText(c)).join("\n");
        // Root first, then one id per line in order — i.e. DFS.
        const next = sequentialIds();
        const expected = (n: MindMapModel): MindMapModel => {
          const id = next();
          return { id, text: n.text, children: n.children.map(expected) };
        };
        expect(textToModel(model.text, text, sequentialIds())).toEqual(expected(model));
      })
    );
  });
});
