/**
 * branchClipboard: serialize → parse round-trips any branch (modulo the root-only
 * `position`, which a pasted branch never keeps), and parseBranch never throws
 * on arbitrary text.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { MindMapModel } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
import { parseBranch, serializeBranch } from "./branchClipboard";

function withoutPosition(node: MindMapModel): MindMapModel {
  const { position: _position, ...rest } = node;
  return { ...rest, children: node.children.map(withoutPosition) };
}

describe("branchClipboard properties", () => {
  it("round-trips any branch, dropping only position", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(parseBranch(serializeBranch(node))).toEqual(withoutPosition(node));
      })
    );
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => parseBranch(text)).not.toThrow();
      })
    );
  });
});
