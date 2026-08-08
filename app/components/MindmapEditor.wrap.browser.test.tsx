import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  type EditorPreferences,
} from "../application/editorPreferences";
import {
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
} from "../lib/measureText";

// Real browser → real canvas measurement, so these assert the actual rendered
// geometry rather than the Node-fallback estimate.
const SENTENCE = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
/** Comfortably past the cap however the font measures. */
const LONG = SENTENCE.repeat(6);
/** Long enough to reach the cap, far shorter than LONG. */
const MEDIUM = SENTENCE.repeat(2);

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "short", text: "hi", children: [] },
    { id: "medium", text: MEDIUM, children: [] },
    { id: "long", text: LONG, children: [] },
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

function seedPrefs(overrides: Partial<EditorPreferences>) {
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ ...DEFAULT_PREFERENCES, ...overrides })
  );
}

function canvas(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

async function ready() {
  await waitFor(() => api().getNodeClickPoint("long"));
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
}

async function rect(id: string) {
  return await waitFor(() => api().getNodeRect(id));
}

/** Click a node, then Space to drop into edit mode. */
async function edit(nodeId: string) {
  const point = await waitFor(() => api().getNodeClickPoint(nodeId));
  await userEvent.click(canvas(), {
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  });
  await waitFor(() => api().getActiveNodeId() === nodeId);
  await userEvent.keyboard("[Space]");
  await waitFor(() => api().getSelection().editing === true);
}

afterEach(() => {
  localStorage.removeItem(PREFERENCES_KEY);
});

beforeEach(() => {
  localStorage.removeItem(PREFERENCES_KEY);
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

describe("node max width (browser e2e)", () => {
  it("stops widening at the cap and grows downwards instead", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await ready();

    const short = await rect("short");
    const medium = await rect("medium");
    const long = await rect("long");

    // The stage is never zoomed here, so screen px are world px.
    const MAX_BOX = NODE_MAX_CONTENT_WIDTH + NODE_PADDING * 2;
    expect(short.width).toBeLessThanOrEqual(MAX_BOX);
    expect(medium.width).toBeLessThanOrEqual(MAX_BOX);
    expect(long.width).toBeLessThanOrEqual(MAX_BOX);

    // Up to the cap a node still grows with its text…
    expect(medium.width).toBeGreaterThan(short.width);
    // …past it, tripling the text buys height, not width (the few px of
    // difference are just where the greedy wrap happens to land a word).
    expect(long.height).toBeGreaterThan(medium.height);
    expect(long.width - medium.width).toBeLessThan(NODE_MAX_CONTENT_WIDTH * 0.1);
  });

  it("keeps the box identical between display and edit mode", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await ready();

    const before = await rect("long");
    await edit("long");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    const during = await api().getNodeRect("long")!;

    // The editing path re-derives the box from the caret's own line
    // measurement; if that wrapped at a different width than the layout did,
    // the node would visibly jump the moment the caret lands in it.
    expect(during!.width).toBeCloseTo(before.width, 5);
    expect(during!.height).toBeCloseTo(before.height, 5);
  });

  it("does not widen further as more text is typed", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await ready();
    await edit("long");

    const before = await api().getNodeRect("long")!;
    await userEvent.keyboard("{End}");
    await userEvent.keyboard(" and quite a lot more text besides");
    await waitFor(() => api().getSelection().cursorPos > LONG.length);

    const after = await api().getNodeRect("long")!;
    expect(after!.width).toBeCloseTo(before!.width, 5);
    expect(after!.height).toBeGreaterThanOrEqual(before!.height);
  });

  it("places the caret on the wrapped line that was clicked", async () => {
    // Any click lands the caret (no select-first step) so this measures the
    // click → caret mapping directly.
    seedPrefs({ selectionMode: false });
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await ready();

    const box = await rect("long");
    // Bottom-LEFT of the box: on the last wrapped line, at its start. Were the
    // caret geometry unaware of soft wraps it would see a single line and
    // clamp this to offset 0.
    await userEvent.click(canvas(), {
      position: {
        x: Math.round(box.x + NODE_PADDING + 2),
        y: Math.round(box.y + box.height - 8),
      },
    });
    await waitFor(() => api().getActiveNodeId() === "long");
    expect(api().getSelection().cursorPos).toBeGreaterThan(0);
  });
});
