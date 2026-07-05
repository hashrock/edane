import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// DFS order: root, a, b
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

function hiddenInput(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(
    'textarea[style*="caret-color"]'
  )!;
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

describe("MindmapEditor clipboard", () => {
  it("pastes multiline text as a node subtree", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const input = hiddenInput();
    input.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "X\n  Y\nZ");
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() =>
      api()
        .getModel()
        .children.some((c) => c.text === "X")
    );
    const root = api().getModel();
    const x = root.children.find((c) => c.text === "X")!;
    expect(x.children[0]?.text).toBe("Y"); // indentation → child
    expect(root.children.some((c) => c.text === "Z")).toBe(true);
  });

  it("cuts a branch and pastes it as a child of the selected node", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await waitFor(() => api().getNodeClickPoint("a"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    // Select node "a" (selection mode, not editing).
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getSelection().editing === false);

    // Cut the branch → "a" leaves the tree, focus lands on the previous node.
    hiddenInput().dispatchEvent(
      new ClipboardEvent("cut", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      })
    );
    await waitFor(() =>
      api()
        .getModel()
        .children.every((c) => c.text !== "Alpha")
    );
    await waitFor(() => api().getActiveNodeId() === "root");

    // Paste the branch as a child of the (now selected) root.
    hiddenInput().dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      })
    );
    await waitFor(() =>
      api()
        .getModel()
        .children.some((c) => c.text === "Alpha")
    );
    const pasted = api()
      .getModel()
      .children.find((c) => c.text === "Alpha")!;
    expect(pasted.id).not.toBe("a"); // fresh id on paste
  });

  it("copies the selected subtree as a JSON branch and pastes it back with node kinds intact", async () => {
    // A branch with a non-text (link) child: Markdown would flatten the kind,
    // JSON must round-trip it.
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "https://example.com",
          type: "link",
          linkTitle: "Example",
          children: [],
        },
      ],
    };
    render(
      <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // Copy root's whole subtree; the JSON payload lands in the custom MIME.
    const copyDt = new DataTransfer();
    hiddenInput().dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: copyDt,
        bubbles: true,
        cancelable: true,
      })
    );
    const json = copyDt.getData("application/x-edane-branch");
    expect(json).not.toBe("");
    expect(JSON.parse(json).children[0].type).toBe("link");

    // Paste it back onto the selected root: it pastes as a child branch with
    // fresh ids and the link kind preserved — no Markdown dialog / decompose.
    const pasteDt = new DataTransfer();
    pasteDt.setData("application/x-edane-branch", json);
    pasteDt.setData("text/plain", "- Root\n  - Example"); // would look like markdown
    hiddenInput().dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: pasteDt,
        bubbles: true,
        cancelable: true,
      })
    );

    const pastedRoot = await waitFor(() =>
      api()
        .getModel()
        .children.find((c) => c.text === "Root")
    );
    expect(pastedRoot.id).not.toBe("root"); // fresh id
    expect(pastedRoot.children[0]?.type).toBe("link"); // kind survived
    expect(pastedRoot.children[0]?.linkTitle).toBe("Example");
  });

  it("copies the selected subtree to the system clipboard as Markdown", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // Root is selected on load; copy its whole subtree.
    const dt = new DataTransfer();
    hiddenInput().dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(dt.getData("text/plain")).toBe(
      ["- Root", "  - Alpha", "  - Bravo"].join("\n")
    );
  });
});
