import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import {
  measureModelNode,
  flattenToNodes,
  nodeDisplayText,
  nodeTextOffsetX,
  supportsCheckbox,
  checkboxOffset,
  CHECKBOX_SIZE,
  CHECKBOX_GAP,
  FAVICON_SIZE,
  FAVICON_GAP,
} from "./nodeUtils";
import {
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
  LINE_HEIGHT,
} from "../lib/measureText";

// "node" project: no DOM, so text measurement is the deterministic estimate and
// images fall back to the loading placeholder (240×160, already under the cap).
const LONG = "x".repeat(600);

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
  ];

  for (const [name, m] of kinds) {
    it(`keeps a ${name} node inside the cap`, () => {
      // nodeBoxWidth only adds the fixed padding, so the content bound is the
      // whole story; measureText.test.ts pins the padded box once.
      expect(measureModelNode(m).width).toBeLessThanOrEqual(
        NODE_MAX_CONTENT_WIDTH
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
  it("caps every flat node", () => {
    const nodes = flattenToNodes(
      model({
        text: LONG,
        children: [model({ id: "t", text: LONG })],
      })
    );
    expect(nodes.length).toBeGreaterThan(1);
    for (const n of nodes) {
      expect(n.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
    }
  });
});

describe("nodeDisplayText", () => {
  it("shows a link's fetched title, not its URL", () => {
    expect(
      nodeDisplayText({ type: "link", text: "https://e/x", linkTitle: "T" })
    ).toBe("T");
  });

  it("falls back to the URL when the title is absent or empty", () => {
    expect(nodeDisplayText({ type: "link", text: "https://e/x" })).toBe(
      "https://e/x"
    );
    expect(
      nodeDisplayText({ type: "link", text: "https://e/x", linkTitle: "" })
    ).toBe("https://e/x");
  });

  it("leaves every other kind on its own text", () => {
    // A linkTitle left behind by a link → text conversion must not leak into
    // what a text node shows.
    expect(nodeDisplayText({ text: "plain", linkTitle: "stale" })).toBe("plain");
    expect(nodeDisplayText({ type: "image", text: "https://e/i.png" })).toBe(
      "https://e/i.png"
    );
  });

  it("is the string the box is measured from", () => {
    // The regression this pins: the box was sized from the title while the
    // canvas painted the (far longer) URL, so the text overflowed its own node.
    const m = model({
      type: "link",
      text: `https://example.com/${LONG}`,
      linkTitle: "Short",
    });
    const titleOnly = measureModelNode(model({ text: "Short" }));
    expect(measureModelNode(m).width).toBe(titleOnly.width);
  });

  it("counts the favicon column on top of the displayed title", () => {
    const bare = measureModelNode(
      model({ type: "link", text: "https://e/x", linkTitle: "Short" })
    );
    const withIcon = measureModelNode(
      model({
        type: "link",
        text: "https://e/x",
        linkTitle: "Short",
        favicon: "https://e/f.ico",
      })
    );
    expect(withIcon.width).toBe(bare.width + FAVICON_SIZE + FAVICON_GAP);
  });
});

describe("task checkbox geometry", () => {
  const COL = CHECKBOX_SIZE + CHECKBOX_GAP;

  it("only the kinds that draw a text line get a checkbox", () => {
    expect(supportsCheckbox("text")).toBe(true);
    expect(supportsCheckbox("link")).toBe(true);
    expect(supportsCheckbox("image")).toBe(false);
    expect(supportsCheckbox("markdown")).toBe(false);
  });

  it("costs nothing until the node is actually a task", () => {
    expect(checkboxOffset(model({ text: "x" }))).toBe(0);
    expect(checkboxOffset(model({ text: "x", checked: false }))).toBe(COL);
    expect(checkboxOffset(model({ text: "x", checked: true }))).toBe(COL);
    // A kind that shows no box pays no column even if the flag is set.
    expect(checkboxOffset(model({ type: "image", text: "u", checked: false }))).toBe(0);
  });

  it("widens the box by exactly its column", () => {
    const plain = measureModelNode(model({ text: "buy milk" }));
    const task = measureModelNode(model({ text: "buy milk", checked: false }));
    expect(task.width).toBe(plain.width + COL);
    expect(task.height).toBe(plain.height);
  });

  it("stacks with a link's favicon column", () => {
    const base = measureModelNode(model({ type: "link", text: "u", linkTitle: "T" }));
    const both = measureModelNode(
      model({
        type: "link",
        text: "u",
        linkTitle: "T",
        favicon: "https://e/f.ico",
        checked: true,
      })
    );
    expect(both.width).toBe(base.width + COL + FAVICON_SIZE + FAVICON_GAP);
  });

  it("takes its column out of the cap, so a long task still fits the box", () => {
    // The checkbox is chrome INSIDE the box: text wrapped at the full cap
    // would overflow the node by exactly the checkbox column.
    const task = measureModelNode(model({ text: LONG, checked: false }));
    expect(task.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
  });

  it("starts the text after the checkbox, and after the favicon too", () => {
    expect(nodeTextOffsetX(model({ text: "x" }))).toBe(NODE_PADDING);
    expect(nodeTextOffsetX(model({ text: "x", checked: false }))).toBe(
      NODE_PADDING + COL
    );
    expect(
      nodeTextOffsetX(
        model({ type: "link", text: "u", favicon: "https://e/f.ico", checked: true })
      )
    ).toBe(NODE_PADDING + COL + FAVICON_SIZE + FAVICON_GAP);
  });

  it("carries the flag onto the flat render node", () => {
    const nodes = flattenToNodes(
      model({ text: "R", children: [model({ id: "t", text: "task", checked: true })] })
    );
    expect(nodes.find((n) => n.id === "t")!.checked).toBe(true);
  });
});
