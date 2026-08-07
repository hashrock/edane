import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { measureModelNode, flattenToNodes, nodeBoxWidth } from "./nodeUtils";
import {
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
  LINE_HEIGHT,
} from "../lib/measureText";

// "node" project: no DOM, so text measurement is the deterministic estimate and
// images fall back to the loading placeholder (240×160, already under the cap).
const LONG = "x".repeat(600);
const MAX_BOX = NODE_MAX_CONTENT_WIDTH + NODE_PADDING * 2;

function model(over: Partial<MindMapModel>): MindMapModel {
  return { id: "n", text: "", children: [], ...over };
}

describe("measureModelNode width cap", () => {
  // Every kind that can hold unbounded content, and how it obeys the cap.
  const kinds: [string, MindMapModel][] = [
    ["text", model({ text: LONG })],
    ["link (no favicon)", model({ type: "link", text: LONG })],
    [
      "link (favicon leaves room for itself)",
      model({ type: "link", text: LONG, favicon: "https://e/f.ico" }),
    ],
    ["markdown", model({ type: "markdown", text: `# ${LONG}` })],
    ["collapsed object", model({ type: "object", text: LONG, collapsed: true })],
    [
      "expanded object card",
      model({
        type: "object",
        text: LONG,
        children: [{ id: "r", text: `キー: ${LONG}`, children: [] }],
      }),
    ],
  ];

  for (const [name, m] of kinds) {
    it(`keeps a ${name} node inside the cap`, () => {
      expect(measureModelNode(m).width).toBeLessThanOrEqual(
        NODE_MAX_CONTENT_WIDTH
      );
      expect(nodeBoxWidth(measureModelNode(m).width, true)).toBeLessThanOrEqual(
        MAX_BOX
      );
    });
  }

  it("caps the live edit buffer too, so the box can't stretch while typing", () => {
    const m = model({ text: "short" });
    expect(measureModelNode(m, LONG).width).toBeLessThanOrEqual(
      NODE_MAX_CONTENT_WIDTH
    );
  });

  it("trades width for height once the cap is reached", () => {
    const short = measureModelNode(model({ text: "x" }));
    const long = measureModelNode(model({ text: LONG }));
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.height).toBeGreaterThanOrEqual(short.height + LINE_HEIGHT);
  });

  it("keeps the markdown card one line tall (it ellipsises, not wraps)", () => {
    const one = measureModelNode(model({ type: "markdown", text: "# t" }));
    const long = measureModelNode(model({ type: "markdown", text: `# ${LONG}` }));
    expect(long.height).toBe(one.height);
  });
});

describe("flattenToNodes width cap", () => {
  it("caps every flat node, card rows included", () => {
    const nodes = flattenToNodes(
      model({
        text: LONG,
        children: [
          model({ id: "t", text: LONG }),
          model({
            id: "o",
            type: "object",
            text: LONG,
            children: [{ id: "f", text: `キー: ${LONG}`, children: [] }],
          }),
        ],
      })
    );
    expect(nodes.length).toBeGreaterThan(3);
    for (const n of nodes) {
      expect(n.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
    }
  });
});
