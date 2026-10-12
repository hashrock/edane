/**
 * Property-based test for the branch clipboard payload.
 *
 * `serializeBranch` / `parseBranch` are the two halves of a copy → paste
 * round-trip across tabs. The example tests pin malformed payloads; this
 * sweeps arbitrary subtrees so a branch that edane itself wrote can never
 * come back altered, and arbitrary foreign text can never throw.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { subtreeIds } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
import { parseBranch, serializeBranch } from "./branchClipboard";

describe("branch clipboard (property-based)", () => {
  it("parseBranch(serializeBranch(n)) reproduces the branch exactly", () => {
    fc.assert(
      fc.property(nodeArb, (generated) => {
        // nodeArb yields a root, which may carry a canvas `position`; a pasted
        // branch is never a root, so that is the one field parse drops.
        const { position: _position, ...node } = generated;
        expect(parseBranch(serializeBranch(node))).toEqual(node);
      })
    );
  });

  it("a parsed branch never carries a root-only `position`", () => {
    fc.assert(
      fc.property(nodeArb, fc.integer(), fc.integer(), (node, x, y) => {
        const withPosition = { ...node, position: { x, y } };
        const parsed = parseBranch(JSON.stringify(withPosition));
        expect(parsed).not.toBeNull();
        expect(parsed!.position).toBeUndefined();
      })
    );
  });

  it("parseBranch never throws on arbitrary text and yields unique ids when it parses", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        const parsed = parseBranch(text);
        if (parsed === null) return;
        const ids = subtreeIds(parsed);
        expect(new Set(ids).size).toBe(ids.length);
      })
    );
  });
});
