/**
 * branchClipboard: any branch (a tree with unique ids, `position` only on
 * roots) survives serialize -> parse unchanged except that `position` is
 * dropped (a pasted branch is never a document root), and parseBranch never
 * throws or yields duplicate ids for arbitrary text.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { subtreeIds, type MindMapModel } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
import { parseBranch, serializeBranch } from "./branchClipboard";

function withoutPosition(node: MindMapModel): MindMapModel {
  const { position: _position, ...rest } = node;
  return { ...rest, children: node.children.map(withoutPosition) };
}

describe("branchClipboard properties", () => {
  it("round-trips a branch, dropping only the root-only position", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(parseBranch(serializeBranch(node))).toEqual(withoutPosition(node));
      })
    );
  });

  it("never throws and always yields unique ids for arbitrary text", () => {
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
