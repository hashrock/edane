/**
 * Property-based test for the branch clipboard payload.
 *
 * `serializeBranch` → `parseBranch` is the edane-to-edane paste path, so it
 * must round-trip any valid subtree exactly (ids, kinds, formatting), and
 * whatever string arrives under the MIME must never throw or yield a tree
 * that breaks the unique-id invariant.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { subtreeIds } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
import { parseBranch, serializeBranch } from "./branchClipboard";

describe("branch clipboard (property)", () => {
  it("parseBranch(serializeBranch(node)) round-trips a valid subtree", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        // A branch is never a root, so `position` (root-only) is the one
        // field parseBranch deliberately drops.
        const { position: _position, ...expected } = node;
        expect(parseBranch(serializeBranch(node))).toEqual(expected);
      })
    );
  });

  it("never throws on arbitrary text or JSON, and any result has unique ids", () => {
    const payloadArb = fc.oneof(
      fc.string(),
      fc.jsonValue().map((v) => JSON.stringify(v))
    );
    fc.assert(
      fc.property(payloadArb, (text) => {
        const parsed = parseBranch(text);
        if (parsed === null) return;
        const ids = subtreeIds(parsed);
        expect(new Set(ids).size).toBe(ids.length);
      })
    );
  });
});
