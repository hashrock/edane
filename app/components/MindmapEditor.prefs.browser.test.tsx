import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import {
  PREFERENCES_KEY,
  type EditorPreferences,
} from "../application/editorPreferences";

// DFS order: root, a, a1, b
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "a",
      text: "Alpha",
      children: [{ id: "a1", text: "Child", children: [] }],
    },
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

function seedPrefs(overrides: Partial<EditorPreferences>) {
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({
      selectionMode: true,
      tabBehavior: "indent",
      arrowBehavior: "collapse",
      ...overrides,
    })
  );
}

async function clickNode(id: string) {
  const point = await waitFor(() => api().getNodeClickPoint(id));
  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  await userEvent.click(canvas, {
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  });
}

async function renderEditor() {
  render(
    <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
  );
  await waitFor(() => api().getActiveNodeId() === "root");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
}

// localStorage is shared across test files in the same browser session —
// leaving seeded preferences behind would flip other editor tests into
// always-edit mode.
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

describe("preference: tabBehavior = insert-child", () => {
  it("Tab on a selected node inserts a child and edits it", async () => {
    seedPrefs({ tabBehavior: "insert-child" });
    await renderEditor();

    await clickNode("b");
    await waitFor(() => api().getSelection().editing === false);

    await userEvent.keyboard("{Tab}");
    // A new (empty) child of "b" is active, in edit mode.
    await waitFor(() => api().getSelection().editing === true);
    const activeId = api().getActiveNodeId()!;
    const b = api()
      .getModel()
      .children.find((n) => n.id === "b")!;
    expect(b.children.map((c) => c.id)).toContain(activeId);
  });
});

describe("preference: arrowBehavior = navigate", () => {
  it("→ moves into the child, ← returns to the parent (no folding)", async () => {
    seedPrefs({ arrowBehavior: "navigate" });
    await renderEditor();

    await clickNode("a");
    await waitFor(() => api().getActiveNodeId() === "a");

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => api().getActiveNodeId() === "a1");

    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => api().getActiveNodeId() === "a");
    // Left must not have folded the branch.
    const a = api()
      .getModel()
      .children.find((n) => n.id === "a")!;
    expect(a.collapsed).not.toBe(true);
  });
});

describe("preference: selectionMode = false (always edit)", () => {
  it("a single click lands in edit mode and Escape stays there", async () => {
    seedPrefs({ selectionMode: false });
    await renderEditor();

    await clickNode("a");
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getSelection().editing === true);

    // Escape must not exit editing (there is no selection mode to return to)
    // and the keyboard must stay live.
    await userEvent.keyboard("{Escape}");
    expect(api().getSelection().editing).toBe(true);
    expect(api().getActiveNodeId()).toBe("a");
  });

  it("Cmd/Ctrl+Shift+Backspace deletes the active branch", async () => {
    seedPrefs({ selectionMode: false });
    await renderEditor();

    await clickNode("a");
    await waitFor(() => api().getActiveNodeId() === "a");

    await userEvent.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
    await waitFor(
      () => !api().getModel().children.some((n) => n.id === "a")
    );
    // Refocused on the nearest surviving node (the root precedes "a").
    expect(api().getActiveNodeId()).toBe("root");
  });
});

describe("settings dialog", () => {
  it("persists a change to localStorage via the command palette", async () => {
    await renderEditor();

    // Tailwind isn't loaded in this harness, so the overlays' z-index doesn't
    // apply and the Konva canvas intercepts pointer clicks — drive the palette
    // by keyboard and toggle the checkbox via a direct DOM click instead.
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(
      () =>
        (document.activeElement as HTMLInputElement | null)?.placeholder ===
        "コマンドを検索..."
    );
    await userEvent.keyboard("エディタ設定");
    await userEvent.keyboard("{Enter}");

    const checkbox = await waitFor(() =>
      document.querySelector<HTMLInputElement>(
        '[aria-label="エディタ設定"] input[type="checkbox"]'
      )
    );
    expect(checkbox.checked).toBe(true);
    checkbox.click();

    await waitFor(() => {
      const raw = localStorage.getItem(PREFERENCES_KEY);
      return raw !== null && JSON.parse(raw).selectionMode === false;
    });
  });
});
