import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [{ id: "a", text: "Alpha", children: [] }],
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
      // not ready
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const dropContainer = () =>
  document.querySelector('[data-testid="mm-canvas"]')!.parentElement!;

const UPLOADED_URL = "https://cdn.example/uploaded.png";
const realFetch = globalThis.fetch;

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
  // Stub the R2 upload endpoint so the drop flow resolves to a known URL.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/images") && init?.method === "POST") {
      return new Response(JSON.stringify({ url: UPLOADED_URL }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("MindmapEditor drag & drop image upload", () => {
  it("dropping an image file creates an image child node with the uploaded URL", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", {
      type: "image/png",
    });
    const dt = new DataTransfer();
    dt.items.add(file);

    // Drop in the far corner so it misses every node → falls back to the active
    // node (root), attaching the image as root's child.
    dropContainer().dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 5,
        clientY: 5,
      })
    );

    const imageNode = await waitFor(() =>
      api()
        .getModel()
        .children.find((c) => c.type === "image")
    );
    expect(imageNode.text).toBe(UPLOADED_URL);
  });
});
