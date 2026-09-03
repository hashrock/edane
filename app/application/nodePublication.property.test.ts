/**
 * Property-based tests for node publication: the URL pair and the path
 * parser are inverses for any id and origin, the published JSON is exactly
 * the allowlisted fields (view state never leaks), the breadcrumb is the
 * ancestor chain, and the serve gate is the stated conjunction.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { findParentAndIndex, type MindMapModel } from "../domain/model";
import { allIds, modelArb, pick } from "../domain/model.arb";
import {
  canServePublication,
  nodePathTexts,
  parsePublicationPath,
  publicationUrls,
  publishedNodeJson,
  type PublishedNode,
} from "./nodePublication";

const originArb = fc.constantFrom(
  "https://edane.app",
  "https://edane.app/",
  "http://localhost:5173//",
  "https://example.com:8443"
);
const pubIdArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 16 })
);

describe("publication URLs ↔ path", () => {
  it("the file part of each URL parses back to the id and format", () => {
    fc.assert(
      fc.property(originArb, pubIdArb, (origin, pubId) => {
        const urls = publicationUrls(origin, pubId);
        for (const format of ["json", "md"] as const) {
          const url = new URL(urls[format]);
          expect(url.pathname.startsWith("/pub/")).toBe(true);
          expect(url.pathname).not.toContain("//");
          const file = url.pathname.slice("/pub/".length);
          const parsed = parsePublicationPath(file);
          expect(parsed).not.toBeNull();
          expect(parsed!.format).toBe(format);
          expect(decodeURIComponent(parsed!.pubId)).toBe(pubId);
        }
      })
    );
  });

  it("parsePublicationPath never throws, and a parse reassembles to the input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 30 }), (file) => {
        const parsed = parsePublicationPath(file);
        if (parsed === null) {
          expect(/^.+\.(json|md)$/.test(file)).toBe(false);
          return;
        }
        expect(parsed.pubId).not.toBe("");
        expect(`${parsed.pubId}.${parsed.format}`).toBe(file);
      })
    );
  });
});

describe("publishedNodeJson", () => {
  it("is exactly the allowlisted fields, recursively — no collapsed, no position", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const expected = (n: MindMapModel): PublishedNode => {
          const out: PublishedNode = { id: n.id, text: n.text, children: n.children.map(expected) };
          for (const k of ["type", "fontSize", "bold", "linkTitle", "favicon", "checked"] as const) {
            if (n[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = n[k];
          }
          return out;
        };
        const json = publishedNodeJson(model);
        expect(json).toEqual(expected(model));
        const walk = (n: PublishedNode) => {
          expect("collapsed" in n).toBe(false);
          expect("position" in n).toBe(false);
          n.children.forEach(walk);
        };
        walk(json);
      })
    );
  });
});

describe("nodePathTexts", () => {
  it("is the ancestor chain's texts from the root down to the node; null for unknown ids", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), (model, n) => {
        const nodeId = pick(allIds(model), n);
        const chain: string[] = [];
        let id = nodeId;
        for (;;) {
          const info = findParentAndIndex(model, id);
          if (!info) break;
          chain.unshift(info.parent.children[info.index].text);
          id = info.parent.id;
        }
        chain.unshift(model.text);
        expect(nodePathTexts(model, nodeId)).toEqual(chain);
        expect(nodePathTexts(model, "no-such-node")).toBeNull();
      })
    );
  });
});

describe("canServePublication", () => {
  it("serves iff the note exists, is public and is not trashed", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.record({
            isPublic: fc.boolean(),
            deletedAt: fc.constantFrom(null, "2024-01-01T00:00:00Z"),
          })
        ),
        (note) => {
          expect(canServePublication(note)).toBe(!!note && note.isPublic && note.deletedAt === null);
        }
      )
    );
  });
});
