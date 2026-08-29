import { describe, it, expect } from "vitest";
import { toSiteNode } from "./siteNode";
import type { MindMapModel } from "../domain/model";

const TREE: MindMapModel = {
  id: "r",
  text: "root",
  children: [
    { id: "a", text: "A", type: "link", collapsed: true, children: [] },
    { id: "b", text: "B", children: [{ id: "b1", text: "b1", children: [] }] },
  ],
};

describe("toSiteNode", () => {
  it("keeps id/text/type/children, resolves default type, drops view state", () => {
    expect(toSiteNode(TREE)).toEqual({
      id: "r",
      type: "text",
      text: "root",
      children: [
        { id: "a", type: "link", text: "A", children: [] },
        { id: "b", type: "text", text: "B", children: [{ id: "b1", type: "text", text: "b1", children: [] }] },
      ],
    });
  });
});
