/**
 * Property-based test for the branch clipboard payload.
 *
 * The copy → paste round-trip and id uniqueness are already swept in
 * persistence.property.test.ts; this pins what they don't: a pasted branch is
 * never a document root, so a `position` smuggled in under BRANCH_MIME is
 * dropped by `parseBranch` itself rather than by whoever nests it later.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { nodeArb, positionArb } from "../domain/model.arb";
import { parseBranch } from "./branchClipboard";

describe("parseBranch (property-based)", () => {
  it("never carries a root-only `position`, wherever it appears in the payload", () => {
    fc.assert(
      fc.property(nodeArb, positionArb, (node, position) => {
        const withPosition = { ...node, children: node.children.map((c) => ({ ...c, position })), position };
        const parsed = parseBranch(JSON.stringify(withPosition));
        expect(parsed).not.toBeNull();
        expect(parsed!.position).toBeUndefined();
        expect(parsed!.children.every((c) => c.position === undefined)).toBe(true);
      })
    );
  });
});
