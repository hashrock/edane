import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "a", text: "Alpha", children: [] },
    { id: "b", text: "Bravo", children: [] },
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
      // not ready
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

async function activate(nodeId: string) {
  const point = await waitFor(() => api().getNodeClickPoint(nodeId));
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  const canvas = document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
  await userEvent.click(canvas, {
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  });
  await waitFor(() => api().getActiveNodeId() === nodeId);
}

describe("MindmapEditor undo/redo", () => {
  it("undoes and redoes a structural edit (Enter adds a node)", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await activate("a");

    const before = api().getModel().children.length; // 2
    // Enter at end of "Alpha" adds an empty sibling.
    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => api().getModel().children.length === before + 1);

    // Undo removes it.
    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => api().getModel().children.length === before);

    // Redo (Cmd+Shift+Z) re-adds it — guards the uppercase-"Z" key regression.
    await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    await waitFor(() => api().getModel().children.length === before + 1);
  });

  it("undoes and redoes typed text", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await activate("a");

    await userEvent.keyboard("{End}");
    await userEvent.keyboard("X");
    await waitFor(() => {
      const t = api().getModel().children[0].text;
      return t !== "Alpha" ? t : null;
    });
    expect(api().getModel().children[0].text).toContain("X");

    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => api().getModel().children[0].text === "Alpha");

    await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    await waitFor(() => api().getModel().children[0].text.includes("X"));
  });
});
