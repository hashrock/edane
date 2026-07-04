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
  // A single click only selects; Space enters edit mode (caret + text input).
  await userEvent.keyboard("[Space]");
  await waitFor(() => api().getSelection().editing === true);
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

  it("undoing a pasted branch lands the active node on the nearest surviving neighbour (regression)", async () => {
    // Undo only restores the document (see UndoManager); if the active node
    // was part of what got undone, activeNodeId used to keep pointing at a
    // node that no longer exists — silently swallowing every subsequent
    // keyboard action until the user undid again. reconcileView now refocuses
    // onto the nearest surviving node in flat order (predecessor preferred),
    // mirroring deleteNode, instead of jumping all the way to the root.
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "Alpha",
          children: [{ id: "a1", text: "A-child", children: [] }],
        },
        { id: "b", text: "Bravo", children: [] },
      ],
    };
    render(
      <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;

    // Select "a" (a branch with a child) and copy it.
    const pointA = await waitFor(() => api().getNodeClickPoint("a"));
    await userEvent.click(canvas, {
      position: { x: Math.round(pointA.x), y: Math.round(pointA.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getSelection().editing === false);
    document.querySelector("textarea")!.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      })
    );

    // Select "b" and paste the branch as its child.
    const pointB = await waitFor(() => api().getNodeClickPoint("b"));
    await userEvent.click(canvas, {
      position: { x: Math.round(pointB.x), y: Math.round(pointB.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "b");
    await waitFor(() => api().getSelection().editing === false);
    document.querySelector("textarea")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      })
    );
    await waitFor(() => {
      const b = api().getModel().children.find((c) => c.id === "b");
      return b != null && b.children.length > 0;
    });

    // One undo removes the whole pasted branch...
    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      const b = api().getModel().children.find((c) => c.id === "b");
      return b != null && b.children.length === 0;
    });

    // ...and activeNodeId must not still point at the now-deleted node. The
    // pasted branch sat right after "b" in flat order, so its predecessor "b"
    // is the nearest survivor and takes focus.
    await waitFor(() => api().getActiveNodeId() === "b");

    // A follow-up keyboard action must actually take effect (previously it
    // silently no-op'd because activeNodeId pointed nowhere).
    const bChildrenBefore = () =>
      api().getModel().children.find((c) => c.id === "b")!.children.length;
    const before = bChildrenBefore();
    document
      .querySelector("textarea")!
      .dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: new DataTransfer(),
          bubbles: true,
          cancelable: true,
        })
      );
    // pasteBranch keeps the clipboard, so pasting again onto the now-active
    // "b" (still holding "Alpha" with its child) should add a child to "b".
    await waitFor(() => bChildrenBefore() > before);
  });
});
