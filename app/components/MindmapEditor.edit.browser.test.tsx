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

/** The host platform's select-all: ⌘A on macOS, Ctrl+A everywhere else. */
const SELECT_ALL = /Mac/i.test(navigator.userAgent) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}";

// Fixed-id tree so each test can target known nodes.
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "a", text: "Alpha", children: [] },
    { id: "b", text: "Bravo", children: [] },
  ],
};

// Sibling insert / split / merge are nested-node behaviours: a tree root
// takes Enter's new node as a child instead (trees are created on purpose,
// via the canvas context menu). So these tests edit nodes under one tree.
const NESTED: MindMapModel = {
  id: "root",
  text: "Root",
  children: [{ id: "t", text: "Tree", children: MODEL.children }],
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

/** Depth-first lookup of a node by id in the current model. */
function findNode(node: MindMapModel, id: string): MindMapModel | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Pin a preference for one test. Built on DEFAULT_PREFERENCES so a case only
 * states the setting it actually depends on, and so changing a default never
 * silently retargets an unrelated test.
 */
function seedPrefs(overrides: Partial<EditorPreferences>) {
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ ...DEFAULT_PREFERENCES, ...overrides })
  );
}

// localStorage is shared across test files in the same browser session, so
// seeded preferences must not outlive the test that set them.
afterEach(() => {
  localStorage.removeItem(PREFERENCES_KEY);
});

// Tailwind isn't loaded in the component test, so force the canvas to a real
// size (otherwise Konva renders into a 0x0 stage and clicks hit nothing).
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

/** Click a node to select it, then Space to drop into edit mode (caret + input).
 *  The first top-level node starts selected, so it is not clicked (a click on
 *  the selected node is the edit-entering re-click). */
async function edit(nodeId: string) {
  const point = await waitFor(() => api().getNodeClickPoint(nodeId));
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  if (api().getActiveNodeId() !== nodeId) {
    const canvas = document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
  }
  await waitFor(() => api().getActiveNodeId() === nodeId);
  await userEvent.keyboard("[Space]");
  await waitFor(() => api().getSelection().editing === true);
}

describe("MindmapEditor edit operations (browser e2e)", () => {
  const tree = () => api().getModel().children[0];

  it("Enter at end of a node adds an empty sibling and focuses it", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(NESTED)} initialTitle="Root" />
    );
    await edit("a");

    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{Enter}");

    // A third child of the tree appears, inserted right after "Alpha".
    await waitFor(() => tree().children.length === 3);
    const t = tree();
    expect(t.children[0].text).toBe("Alpha");
    expect(t.children[1].text).toBe("");
    // The freshly added empty sibling becomes active.
    const activeId = api().getActiveNodeId();
    expect(activeId).toBe(t.children[1].id);
  });

  it("Enter mid-text splits the node into two", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(NESTED)} initialTitle="Root" />
    );
    await edit("a");

    // Put the caret after "Al" (pos 2) and split.
    await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => tree().children.length === 3);
    const t = tree();
    expect(t.children[0].text).toBe("Al");
    expect(t.children[1].text).toBe("pha");
  });

  it("Enter on a tree root adds a child, never a sibling tree", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await edit("a");

    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => api().getModel().children[0].children.length === 1);
    const model = api().getModel();
    expect(model.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(model.children[0].children[0].text).toBe("");
    expect(api().getActiveNodeId()).toBe(model.children[0].children[0].id);
  });

  it("Tab indents a node under its previous sibling; Shift+Tab outdents it", async () => {
    // Indenting is the "indent" tabBehavior, no longer the default — pin it
    // here. The default ("insert-child") is covered in the prefs test file.
    seedPrefs({ tabBehavior: "indent" });
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await edit("b");

    // Tab: "Bravo" becomes a child of "Alpha".
    await userEvent.keyboard("{Tab}");
    await waitFor(() => {
      const alpha = findNode(api().getModel(), "a");
      return alpha != null && alpha.children.length === 1;
    });
    let model = api().getModel();
    expect(model.children.length).toBe(1); // only "Alpha" left at top level
    expect(findNode(model, "a")!.children[0].id).toBe("b");

    // Shift+Tab: "Bravo" goes back up to the top level.
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() => api().getModel().children.length === 2);
    model = api().getModel();
    expect(findNode(model, "a")!.children.length).toBe(0);
    expect(model.children.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("typing replaces a fully-selected node's text (select-then-type rename)", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await edit("a");

    // Select all, then type to replace. Select-all is the *browser's* native
    // textarea binding, not one of our keymap's `meta || ctrl` shortcuts, so it
    // has to be pressed the way the host platform binds it (CI runs Linux).
    await userEvent.keyboard(SELECT_ALL);
    await userEvent.keyboard("Renamed");
    await waitFor(() => findNode(api().getModel(), "a")?.text === "Renamed");
    expect(findNode(api().getModel(), "a")!.text).toBe("Renamed");
  });

  it("Backspace at the start of an empty node deletes it", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(NESTED)} initialTitle="Root" />
    );
    await edit("a");

    // Add an empty sibling after "Alpha", landing inside it.
    await userEvent.keyboard("{End}{Enter}");
    await waitFor(() => api().getModel().children[0].children.length === 3);

    // Backspace at pos 0 of the empty node removes it and lands on "Alpha".
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => api().getModel().children[0].children.length === 2);
    expect(api().getActiveNodeId()).toBe("a");
  });

  it("Backspace at start of a non-empty node merges it into the previous node", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await edit("b");

    // Caret at the very start of "Bravo", then Backspace merges into "Alpha".
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => api().getModel().children.length === 1);
    const model = api().getModel();
    expect(model.children[0].text).toBe("AlphaBravo");
    expect(api().getActiveNodeId()).toBe("a");
  });

  it("Delete at the end of a node merges the next node into it", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await edit("a");

    // Caret at end of "Alpha", then Delete pulls "Bravo" in.
    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{Delete}");
    await waitFor(() => api().getModel().children.length === 1);
    const model = api().getModel();
    expect(model.children[0].text).toBe("AlphaBravo");
    expect(api().getActiveNodeId()).toBe("a");
  });
});
