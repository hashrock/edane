/**
 * Property-based tests for the serialization boundary: whatever the domain
 * produces must survive the trip through JSON (the DB / API / clipboard
 * payload), and whatever comes back from that boundary — including garbage —
 * must be normalized into a well-formed unique-id forest.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isStoredNodeType, type MindMapDocument, type MindMapModel } from "../domain/model";
import { allIds, expectUniqueIds, modelArb, nodeArb, sequentialIds } from "../domain/model.arb";
import {
  modelToText,
  normalizeDocument,
  normalizeTree,
  parseContent,
  serializeDocument,
  textToDocument,
} from "./persistence";
import { parseBranch, serializeBranch } from "./branchClipboard";

function expectWellFormedNode(node: MindMapModel) {
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

function expectWellFormed(doc: MindMapDocument) {
  expectUniqueIds(doc);
  expect(typeof doc.title).toBe("string");
  doc.roots.forEach(expectWellFormedNode);
}

describe("JSON round trips", () => {
  it("parseContent(serializeDocument(m), title) === { ...m, title } for every well-formed document", () => {
    fc.assert(
      fc.property(modelArb, fc.string(), (model, title) => {
        // The title travels outside the content (the note's own column), so it
        // is whatever the caller passes back in.
        expect(parseContent(serializeDocument(model), title)).toEqual({ ...model, title });
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

  it("normalizeDocument and normalizeTree are idempotent", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const once = normalizeDocument(JSON.parse(serializeDocument(model)), model.title)!;
        expect(normalizeDocument({ ...once, version: 2 }, model.title)).toEqual(once);
        for (const root of once.roots) {
          expect(normalizeTree(root, new Set())).toEqual(root);
        }
      })
    );
  });
});

describe("normalization on untrusted input", () => {
  it("normalizeTree returns null or a well-formed tree for any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const out = normalizeTree(value, new Set());
        if (out !== null) {
          expectWellFormedNode(out);
          const ids = allIds({ title: "", roots: [out] });
          expect(new Set(ids).size).toBe(ids.length);
        }
      })
    );
  });

  it("normalizeDocument returns null or a well-formed document for any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.string(), (value, title) => {
        const out = normalizeDocument(value, title);
        if (out !== null) expectWellFormed(out);
      })
    );
  });

  it("repairs duplicated / missing ids without touching the shape", () => {
    fc.assert(
      fc.property(nodeArb, fc.constantFrom("dup", "", 42, null, undefined), (node, badId) => {
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
        expect(normalizeTree(wreck(node), new Set(), sequentialIds())).toEqual(relabel(node));
      })
    );
  });

  it("ids are unique across roots too: a second root reusing the first's id is relabelled", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        fc.pre(model.roots.length > 1);
        const wrecked = { version: 2, roots: model.roots.map((r) => ({ ...r, id: model.roots[0].id })) };
        const out = normalizeDocument(wrecked, model.title, sequentialIds())!;
        expectUniqueIds(out);
        expect(out.roots[0].id).toBe(model.roots[0].id);
      })
    );
  });

  it("parseContent always yields at least one root", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), fc.string(), (content, title) => {
        expect(parseContent(content, title).roots.length).toBeGreaterThan(0);
      })
    );
  });

  it("v1 content (a single node) migrates as one root whose subtree is untouched", () => {
    fc.assert(
      fc.property(nodeArb, fc.string(), (node, title) => {
        const doc = parseContent(JSON.stringify(node), title);
        expect(doc.roots).toEqual([node]);
        expect(doc.title).toBe(title || node.text);
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
    const texts = allIds(m).length + 1; // + the title
    return fc.array(lineText, { minLength: texts, maxLength: texts }).map((ts) => {
      let i = 1;
      const relabel = (n: MindMapModel): MindMapModel => ({
        id: n.id,
        text: ts[i++],
        children: n.children.map(relabel),
      });
      return { title: ts[0], roots: m.roots.map(relabel) };
    });
  });

  it("textToDocument(title, modelToText of each tree) rebuilds the trees under one title root", () => {
    fc.assert(
      fc.property(plainModel, (model) => {
        const text = model.roots.map((c) => modelToText(c)).join("\n");
        // The title root is minted first, then one id per line in DFS order.
        const next = sequentialIds();
        const rootId = next();
        const expected = (n: MindMapModel): MindMapModel => {
          const id = next();
          return { id, text: n.text, children: n.children.map(expected) };
        };
        expect(textToDocument(model.title, text, sequentialIds())).toEqual({
          title: model.title,
          roots: [{ id: rootId, text: model.title, children: model.roots.map(expected) }],
        });
      })
    );
  });
});
