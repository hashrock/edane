import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Navigation order: a, b (the root is the title, not a node)
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
    await waitFor(() => api().getNodeClickPoint("a"));
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

    // "a" (the preselected tree root) takes the pasted nodes as children —
    // a tree root never gets siblings from a paste (that would be new trees).
    await waitFor(() =>
      api()
        .getModel()
        .children[0].children.some((c) => c.text === "X")
    );
    const a = api().getModel().children[0];
    const x = a.children.find((c) => c.text === "X")!;
    expect(x.children[0]?.text).toBe("Y"); // indentation → child
    expect(a.children.some((c) => c.text === "Z")).toBe(true);
    expect(api().getModel().children.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("cuts a branch and pastes it as a child of the selected node", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    // The first top-level node "a" is selected on load (selection mode).
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    await waitFor(() => api().getSelection().editing === false);

    // Cut the branch → "a" leaves the tree; it had no predecessor, so focus
    // lands on the first remaining top-level node "b".
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
    await waitFor(() => api().getActiveNodeId() === "b");

    // Paste the branch as a child of the (now selected) "b".
    hiddenInput().dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      })
    );
    const bNode = () => api().getModel().children.find((c) => c.id === "b")!;
    await waitFor(() => bNode().children.some((c) => c.text === "Alpha"));
    const pasted = bNode().children.find((c) => c.text === "Alpha")!;
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
          id: "p",
          text: "Parent",
          children: [
            {
              id: "a",
              text: "https://example.com",
              type: "link",
              linkTitle: "Example",
              children: [],
            },
          ],
        },
      ],
    };
    render(
      <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
    );
    // The first top-level node "p" is selected on load.
    await waitFor(() => api().getActiveNodeId() === "p");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // Copy p's whole subtree; the JSON payload lands in the custom MIME.
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

    // Paste it back onto the selected "p": it pastes as a child branch with
    // fresh ids and the link kind preserved — no Markdown dialog / decompose.
    const pasteDt = new DataTransfer();
    pasteDt.setData("application/x-edane-branch", json);
    pasteDt.setData("text/plain", "- Parent\n  - Example"); // would look like markdown
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
        .children.find((c) => c.id === "p")!
        .children.find((c) => c.text === "Parent")
    );
    expect(pastedRoot.id).not.toBe("p"); // fresh id
    expect(pastedRoot.children[0]?.type).toBe("link"); // kind survived
    expect(pastedRoot.children[0]?.linkTitle).toBe("Example");
  });

  it("copies the selected subtree to the system clipboard as Markdown", async () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "Alpha",
          children: [
            { id: "a1", text: "One", children: [] },
            { id: "a2", text: "Two", children: [] },
          ],
        },
      ],
    };
    render(
      <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // The first top-level node is selected on load; copy its whole subtree.
    const dt = new DataTransfer();
    hiddenInput().dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(dt.getData("text/plain")).toBe(
      ["- Alpha", "  - One", "  - Two"].join("\n")
    );
  });
});
