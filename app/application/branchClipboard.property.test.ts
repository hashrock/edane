/**
 * branchClipboard: a copied branch pastes back as the same tree (minus the
 * root-only `position`, which a branch never carries), and no string — however
 * malformed — makes parseBranch throw or yield a non-unique-id tree.
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

describe("branch clipboard properties", () => {
  it("round-trips any branch, dropping only the root position", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(parseBranch(serializeBranch(node))).toEqual(withoutPosition(node));
      })
    );
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        parseBranch(text);
      })
    );
  });

  it("reassigns ids so a branch whose ids all collide is unique-id", () => {
    const collide = (n: MindMapModel): MindMapModel => ({
      ...n,
      id: "dup",
      children: n.children.map(collide),
    });
    fc.assert(
      fc.property(nodeArb, (node) => {
        const parsed = parseBranch(serializeBranch(collide(node)));
        expect(parsed).not.toBeNull();
        const ids = subtreeIds(parsed!);
        expect(new Set(ids).size).toBe(ids.length);
      })
    );
  });
});
