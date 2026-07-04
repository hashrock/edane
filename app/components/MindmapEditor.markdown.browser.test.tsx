import { describe, it, expect, beforeEach } from "vitest";
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

function hiddenInput(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(
    'textarea[style*="caret-color"]'
  )!;
}

function pasteMarkdown(md: string) {
  const input = hiddenInput();
  input.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", md);
  input.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    })
  );
}

/** All node texts, depth-first. */
function allNodes(m: MindMapModel): MindMapModel[] {
  return [m, ...m.children.flatMap(allNodes)];
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

describe("MindmapEditor markdown paste", () => {
  it("offers a dialog when pasted text looks like markdown", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    pasteMarkdown("# Title\n- one\n- two");
    await waitFor(() =>
      document.body.textContent?.includes("Markdownを検出しました")
    );
    // Model is untouched until a choice is made.
    expect(api().getModel().children.length).toBe(1);
  });

  it("pastes as a single markdown node", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    pasteMarkdown("# Doc\n- a\n- b");
    const btn = await waitFor(() =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Markdownノードとしてペースト")
      )
    );
    btn.click();

    const md = await waitFor(() =>
      allNodes(api().getModel()).find((n) => n.type === "markdown")
    );
    expect(md.text).toContain("# Doc");
    expect(md.children.length).toBe(0);
  });

  it("decomposes markdown into a node subtree", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    pasteMarkdown("# Heading\n- one\n- two");
    const btn = await waitFor(() =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("分解してペースト")
      )
    );
    btn.click();

    const heading = await waitFor(() =>
      allNodes(api().getModel()).find((n) => n.text === "Heading")
    );
    expect(heading.children.map((c) => c.text)).toEqual(["one", "two"]);
    // The decomposed nodes are plain text, not markdown.
    expect(heading.type).toBeUndefined();
  });
});
