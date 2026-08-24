import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
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

/**
 * Fire a paste of Markdown at the editing textarea. Returns whether the editor
 * called preventDefault — i.e. whether it took the paste over instead of
 * leaving the text insertion to the textarea.
 */
function pasteMarkdown(md: string): { prevented: boolean } {
  const input = hiddenInput();
  input.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", md);
  const notPrevented = input.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    })
  );
  return { prevented: !notPrevented };
}

function canvas(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

/** Select node `id` on the canvas (selection mode, no caret in the text). */
async function selectNode(id: string) {
  const point = await waitFor(() => api().getNodeClickPoint(id));
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  await userEvent.click(canvas(), {
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  });
  await waitFor(() => api().getActiveNodeId() === id);
}

/** Select node `id` and enter text editing on it (caret in the textarea). */
async function editNode(id: string) {
  await selectNode(id);
  await userEvent.keyboard("[Space]");
  await waitFor(() => api().getSelection().editing === true);
}

/** Give the dialog a chance to appear before asserting it did not. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 30));
}

function dialogShown(): boolean {
  return !!document.body.textContent?.includes("Markdown detected");
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
  it("offers a dialog when pasted text looks like markdown in selection mode", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    pasteMarkdown("# Title\n- one\n- two");
    await waitFor(() =>
      document.body.textContent?.includes("Markdown detected")
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
        b.textContent?.includes("Paste as a Markdown node")
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
        b.textContent?.includes("Decompose and paste")
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

  it("lands in selection mode and reverts in one undo", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await selectNode("a");

    const before = api().getModel().children.length; // 1

    pasteMarkdown("# Heading\n- one\n- two");
    const btn = await waitFor(() =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Decompose and paste")
      )
    );
    btn.click();
    await waitFor(() => allNodes(api().getModel()).find((n) => n.text === "Heading"));

    // Paste must stay in selection mode — otherwise the caret sits inside a
    // pasted node and the next keystroke becomes a separate undo step.
    expect(api().getSelection().editing).toBe(false);

    // A single undo fully reverts the decompose paste.
    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => api().getModel().children.length === before);
    expect(allNodes(api().getModel()).some((n) => n.text === "Heading")).toBe(false);
  });
});

describe("MindmapEditor markdown paste while editing", () => {
  it("pastes straight into the text: no dialog, no new nodes, native insertion", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await editNode("a");
    const nodesBefore = allNodes(api().getModel()).length;

    const { prevented } = pasteMarkdown("# Heading\n- one\n- two");

    // Not prevented = the textarea does the insertion itself, so the text lands
    // at the caret (replacing any selection) like ordinary typing.
    expect(prevented).toBe(false);
    await settle();
    expect(dialogShown()).toBe(false);
    // Nothing was decomposed into nodes and editing continues on the same node.
    expect(allNodes(api().getModel()).length).toBe(nodesBefore);
    expect(api().getSelection()).toMatchObject({
      activeNodeId: "a",
      editing: true,
    });
  });

  it("keeps single-line markdown (inline link / bold) native too", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await editNode("a");

    expect(pasteMarkdown("see [docs](https://x.dev)").prevented).toBe(false);
    expect(pasteMarkdown("this is **bold**").prevented).toBe(false);
    await settle();
    expect(dialogShown()).toBe(false);
  });

  it("still offers the dialog once editing is left", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await editNode("a");
    pasteMarkdown("# Heading\n- one");
    await settle();
    expect(dialogShown()).toBe(false);

    // Escape drops back to selection mode; the same paste now asks.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => api().getSelection().editing === false);
    expect(pasteMarkdown("# Heading\n- one").prevented).toBe(true);
    await waitFor(() => dialogShown());
  });
});
