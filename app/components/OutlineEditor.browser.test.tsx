import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import type { MindMapModel } from "../domain/model";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "a", text: "Alpha", children: [] },
    { id: "b", text: "Bravo", children: [] },
  ],
};

// Harness that exposes the shared engine so assertions can read live state.
function Harness() {
  const engine = useNoteEditor({
    initialContent: JSON.stringify(MODEL),
    initialTitle: "Root",
  });
  (window as unknown as { __engine?: NoteEditorEngine }).__engine = engine;
  return <OutlineEditor engine={engine} />;
}

// A model containing a link node and an image node, for the custom-node editor.
const CUSTOM_MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "lnk", text: "https://example.com", type: "link", children: [] },
    {
      id: "img",
      text: "https://example.com/pic.png",
      type: "image",
      children: [],
    },
  ],
};

function CustomHarness() {
  const engine = useNoteEditor({
    initialContent: JSON.stringify(CUSTOM_MODEL),
    initialTitle: "Root",
  });
  (window as unknown as { __engine?: NoteEditorEngine }).__engine = engine;
  return <OutlineEditor engine={engine} />;
}

function engine(): NoteEditorEngine {
  const e = (window as unknown as { __engine?: NoteEditorEngine }).__engine;
  if (!e) throw new Error("engine not exposed yet");
  return e;
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

function findNode(node: MindMapModel, id: string): MindMapModel | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

async function activeTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(() =>
    document.querySelector<HTMLTextAreaElement>("textarea")
  );
}

describe("OutlineEditor custom nodes (browser e2e)", () => {
  it("editing a link node keeps the preview and shows a URL box below", async () => {
    render(<CustomHarness />);
    const linkRow = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("example.com")
      )
    );
    await userEvent.click(linkRow.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "lnk");

    // A URL editor input appears...
    const input = await waitFor(() =>
      linkRow.querySelector<HTMLInputElement>('input[placeholder="リンクのURL"]')
    );
    // ...while the link preview span stays visible (not opacity-0).
    const preview = linkRow.querySelector<HTMLElement>("span.text-blue-600");
    expect(preview).not.toBeNull();
    expect(preview!.className).not.toContain("opacity-0");
    // No floating caret textarea is used for custom nodes.
    expect(document.querySelector("textarea")).toBeNull();

    // Typing edits the node's URL (its `text`).
    await userEvent.click(input);
    await userEvent.fill(input, "https://changed.example");
    await waitFor(
      () => findNode(engine().model, "lnk")?.text === "https://changed.example"
    );
    expect(findNode(engine().model, "lnk")?.text).toBe(
      "https://changed.example"
    );
  });

  it("editing an image node keeps the <img> preview and shows a URL box", async () => {
    render(<CustomHarness />);
    const imgRow = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.querySelector("img")
      )
    );
    await userEvent.click(imgRow.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "img");

    // The <img> preview stays and a URL box appears.
    expect(imgRow.querySelector("img")).not.toBeNull();
    const input = await waitFor(() =>
      imgRow.querySelector<HTMLInputElement>('input[placeholder="画像のURL"]')
    );
    expect(input).not.toBeNull();
  });
});

describe("OutlineEditor (browser e2e)", () => {
  it("renders the root first, then each descendant as an indented row", async () => {
    render(<Harness />);
    await waitFor(() => document.body.textContent?.includes("Alpha"));
    expect(document.body.textContent).toContain("Alpha");
    expect(document.body.textContent).toContain("Bravo");
    // The root is the first outline row (and also mirrored in the header title).
    const rows = document.querySelectorAll("ul > li");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("Root");
  });

  it("↑ from the first child lands on the root instead of stalling", async () => {
    render(<Harness />);
    const alpha = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("Alpha")
      )
    );
    await userEvent.click(alpha.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "a");

    const ta = await activeTextarea();
    await userEvent.click(ta);
    await userEvent.keyboard("{Home}{ArrowUp}");
    // The caret crosses into the root rather than hitting a wall.
    await waitFor(() => engine().state.view.activeNodeId === "root");
    expect(engine().state.view.editing).toBe(true);
  });

  it("tapping a row activates it and typing edits the node", async () => {
    render(<Harness />);
    const alpha = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("Alpha")
      )
    );
    await userEvent.click(alpha.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "a");

    const ta = await activeTextarea();
    await userEvent.click(ta);
    await userEvent.keyboard("{End}!");
    await waitFor(() => findNode(engine().model, "a")?.text === "Alpha!");
    expect(findNode(engine().model, "a")?.text).toBe("Alpha!");
  });

  it("Enter splits / adds a sibling and keeps editing", async () => {
    render(<Harness />);
    const alpha = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("Alpha")
      )
    );
    await userEvent.click(alpha.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "a");

    const ta = await activeTextarea();
    await userEvent.click(ta);
    await userEvent.keyboard("{End}{Enter}");
    // A new empty sibling of "a" is inserted after it and becomes active.
    await waitFor(() => engine().model.children.length === 3);
    const active = engine().state.view.activeNodeId;
    expect(active).not.toBe("a");
    expect(engine().state.view.editing).toBe(true);
  });

  it("the indent button nests a row under its previous sibling", async () => {
    render(<Harness />);
    const bravo = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("Bravo")
      )
    );
    await userEvent.click(bravo.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "b");

    const indentBtn = await waitFor(() =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("title") === "インデント"
      )
    );
    await userEvent.click(indentBtn);
    // "b" becomes the last child of "a".
    await waitFor(() => findNode(engine().model, "a")?.children.length === 1);
    expect(engine().model.children.length).toBe(1);
    expect(findNode(engine().model, "a")?.children[0].id).toBe("b");
  });
});
