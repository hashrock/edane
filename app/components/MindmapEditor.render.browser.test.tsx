import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, {
  type MindmapTestApi,
  type NodeRender,
} from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import {
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
} from "../lib/measureText";
import { FAVICON_SIZE, FAVICON_GAP } from "../application/nodeUtils";

// Real browser → real canvas measurement, so these assert what the node ACTUALLY
// paints (read back off the Konva layer) against the box the layout measured for
// it. The two are derived by different code paths — measureModelNode sizes the
// box, the draw builds the visual lines — so only comparing the painted result
// with the box catches them disagreeing. Re-deriving the expected width from
// measureModelNode would just restate the layout to itself.

/** 1×1 transparent PNG — a favicon that really loads in the browser. */
const FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const LONG_URL =
  "https://example.com/" +
  "a-rather-long-path-segment/".repeat(8) +
  "index.html";

// Every case is a child of one top-level node: top-level nodes carry the tree
// root styling (min box width 100, dark fill), which would mask the sizing
// under test; nesting keeps them ordinary nodes on one centred row.
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "hub",
      text: "cases",
      children: [
    { id: "plain", text: "hello world", children: [] },
    { id: "empty", text: "", children: [] },
    {
      // The regression case: the title is far shorter than the URL, so a box
      // measured for one and painted with the other is obviously wrong.
      id: "titled",
      type: "link",
      text: LONG_URL,
      linkTitle: "Example",
      children: [],
    },
    {
      id: "titled-icon",
      type: "link",
      text: LONG_URL,
      linkTitle: "Example",
      favicon: FAVICON,
      children: [],
    },
    { id: "bare", type: "link", text: "https://example.com/a", children: [] },
    { id: "long-bare", type: "link", text: LONG_URL, children: [] },
    { id: "big", text: "big and bold", fontSize: 32, bold: true, children: [] },
      ],
    },
  ],
};

function api(): MindmapTestApi {
  const a = window.__mindmapTest;
  if (!a) throw new Error("__mindmapTest not exposed yet");
  return a;
}

async function waitFor<T>(fn: () => T | null | undefined | false): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v as T;
    } catch {
      // not ready yet
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

/**
 * The node's paint result, once it HAS painted. The layer exists before the
 * first draw runs, so a bare getNodeRender can hand back an empty (but truthy)
 * record — every node in this fixture paints at least one shape.
 */
async function rendered(id: string): Promise<NodeRender> {
  return await waitFor(() => {
    const v = api().getNodeRender(id);
    return v && v.texts.length + v.images.length > 0 ? v : null;
  });
}

/** The one text shape a node paints (every node here draws exactly one). */
function only(r: NodeRender) {
  expect(r.texts).toHaveLength(1);
  return r.texts[0];
}

/**
 * The painted glyphs stay within the box's content area — the box's own
 * padding on both sides. Sub-pixel slack only: this must fail on a favicon
 * column or a title/URL swap, not on a rounding difference.
 */
function expectFitsBox(r: NodeRender) {
  for (const t of r.texts) {
    expect(t.x).toBeGreaterThanOrEqual(r.box.x + NODE_PADDING - 0.5);
    expect(t.x + t.width).toBeLessThanOrEqual(
      r.box.x + r.box.width - NODE_PADDING + 0.5
    );
  }
  for (const img of r.images) {
    expect(img.x).toBeGreaterThanOrEqual(r.box.x + NODE_PADDING - 0.5);
    expect(img.x + img.width).toBeLessThanOrEqual(
      r.box.x + r.box.width - NODE_PADDING + 0.5
    );
  }
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 700px;
    }
  `;
  document.head.appendChild(style);
  render(
    <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
  );
});

describe("node rendering (browser e2e)", () => {
  it("paints a text node's own text inside its box", async () => {
    const r = await rendered("plain");
    expect(only(r).text).toBe("hello world");
    expectFitsBox(r);
  });

  it("paints the italic placeholder for an empty node, inside its box", async () => {
    const r = await rendered("empty");
    const t = only(r);
    expect(t.text).toBe("empty");
    expect(t.fontStyle).toBe("italic");
    expectFitsBox(r);
  });

  it("paints a link's fetched title — not its URL — and sizes the box for it", async () => {
    const r = await rendered("titled");
    const t = only(r);
    expect(t.text).toBe("Example");
    expect(t.text).not.toContain("example.com");
    expectFitsBox(r);
    // Sized for the title: a box measured for the whole URL would have hit the
    // cap instead of hugging one short word.
    expect(r.box.width).toBeLessThan(NODE_MAX_CONTENT_WIDTH);
  });

  it("leaves the favicon its own column beside the title", async () => {
    const r = await waitFor(() => {
      const v = api().getNodeRender("titled-icon");
      // The favicon loads asynchronously and triggers its own redraw.
      return v && v.images.length === 1 ? v : null;
    });
    const icon = r.images[0];
    expect(icon.width).toBe(FAVICON_SIZE);
    expect(icon.x).toBeCloseTo(r.box.x + NODE_PADDING, 1);
    // The title starts after the icon's column, and the box grew by exactly it.
    const t = only(r);
    expect(t.x).toBeCloseTo(icon.x + FAVICON_SIZE + FAVICON_GAP, 1);
    expectFitsBox(r);
    const plain = await rendered("titled");
    expect(r.box.width).toBeCloseTo(
      plain.box.width + FAVICON_SIZE + FAVICON_GAP,
      1
    );
  });

  it("paints the raw URL when no title was fetched", async () => {
    const r = await rendered("bare");
    expect(only(r).text).toBe("https://example.com/a");
    expectFitsBox(r);
  });

  it("wraps a long URL at the cap instead of overflowing its box", async () => {
    const r = await rendered("long-bare");
    const t = only(r);
    expect(t.text).toContain("\n"); // soft-wrapped into visual lines
    expect(t.text.replace(/\n/g, "")).toBe(LONG_URL);
    expect(r.box.width).toBeLessThanOrEqual(
      NODE_MAX_CONTENT_WIDTH + NODE_PADDING * 2
    );
    expectFitsBox(r);
  });

  it("keeps a styled node's box around its larger, bolder glyphs", async () => {
    const r = await rendered("big");
    const t = only(r);
    expect(t.fontSize).toBe(32);
    expect(t.fontStyle).toBe("bold");
    expectFitsBox(r);
    const plain = await rendered("plain");
    expect(r.box.height).toBeGreaterThan(plain.box.height);
  });
});
