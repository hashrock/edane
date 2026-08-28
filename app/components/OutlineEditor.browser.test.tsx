import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import type { MindMapModel } from "../domain/model";
import { NODE_MAX_CONTENT_WIDTH } from "../lib/measureText";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "a", text: "Alpha", children: [] },
    { id: "b", text: "Bravo", children: [] },
  ],
};

// Harness that exposes the shared engine so assertions can read live state.
function harnessFor(model: MindMapModel) {
  return function Harness() {
    const engine = useNoteEditor({
      initialContent: JSON.stringify(model),
      initialTitle: "Root",
    });
    (window as unknown as { __engine?: NoteEditorEngine }).__engine = engine;
    return <OutlineEditor engine={engine} />;
  };
}

const Harness = harnessFor(MODEL);

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

const CustomHarness = harnessFor(CUSTOM_MODEL);

// Task rows: one open, one done, one plain node with no checkbox at all.
const TASK_MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "open", text: "buy milk", checked: false, children: [] },
    { id: "done", text: "buy bread", checked: true, children: [] },
    { id: "plain", text: "just a note", children: [] },
  ],
};

const TaskHarness = harnessFor(TASK_MODEL);

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


// A long single-line item, for the row width cap.
const LONG_MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "long",
      text: "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(6),
      children: [],
    },
  ],
};

const LongHarness = harnessFor(LONG_MODEL);

describe("OutlineEditor row width cap (browser e2e)", () => {
  it("wraps a long item at the same content cap as a canvas node", async () => {
    render(<LongHarness />);
    const row = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("consectetur")
      )
    );
    const content = row.querySelector<HTMLElement>(".cursor-text")!;
    expect(content.getBoundingClientRect().width).toBeLessThanOrEqual(
      NODE_MAX_CONTENT_WIDTH
    );
    // Capped horizontally → the text went vertical instead.
    const span = content.querySelector("span")!;
    expect(span.getBoundingClientRect().height).toBeGreaterThan(24);
  });

  it("gives the overlaid editor exactly the display width", async () => {
    render(<LongHarness />);
    const row = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) =>
        li.textContent?.includes("consectetur")
      )
    );
    const content = row.querySelector<HTMLElement>(".cursor-text")!;
    await userEvent.click(content);
    await waitFor(() => engine().state.view.activeNodeId === "long");
    const ta = await activeTextarea();
    // Display and edit widths must not diverge: the caret would otherwise sit
    // on lines the static row never renders. (The overlay is measured just
    // before it mounts, so it can lag the row by the width of a scrollbar that
    // its own height brings in — a pre-existing artefact of the overlay, not a
    // wrapping mismatch.)
    const taW = ta.getBoundingClientRect().width;
    expect(taW).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
    expect(Math.abs(taW - content.getBoundingClientRect().width)).toBeLessThan(
      20
    );
  });
});

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
      linkRow.querySelector<HTMLInputElement>('input[placeholder="Link URL"]')
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
      imgRow.querySelector<HTMLInputElement>('input[placeholder="Image URL"]')
    );
    expect(input).not.toBeNull();
  });
});

describe("OutlineEditor (browser e2e)", () => {
  it("renders the top-level nodes as rows (the root is the title, not a row)", async () => {
    render(<Harness />);
    await waitFor(() => document.body.textContent?.includes("Alpha"));
    expect(document.body.textContent).toContain("Alpha");
    expect(document.body.textContent).toContain("Bravo");
    // The root is only the header title; the rows start at its children.
    const rows = document.querySelectorAll("ul > li");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Alpha");
    expect(document.body.textContent).toContain("Root");
  });

  it("↑ from the first top-level node stays put (the root is not a row)", async () => {
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
    // Nothing sits above the first top-level node (the root is the title, not
    // a row), so this is the tree's top edge: the caret stays on "a", still
    // editing.
    await new Promise((r) => setTimeout(r, 200));
    expect(engine().state.view.activeNodeId).toBe("a");
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

  it("Enter adds a node (a child of the tree root) and keeps editing", async () => {
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
    // "a" is a tree root, so the new empty node is its child (a sibling would
    // be a new tree); it becomes active.
    await waitFor(() => engine().model.children[0].children.length === 1);
    expect(engine().model.children.length).toBe(2);
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
        (b) => b.getAttribute("title") === "Indent"
      )
    );
    await userEvent.click(indentBtn);
    // "b" becomes the last child of "a".
    await waitFor(() => findNode(engine().model, "a")?.children.length === 1);
    expect(engine().model.children.length).toBe(1);
    expect(findNode(engine().model, "a")?.children[0].id).toBe("b");
  });
});

describe("OutlineEditor task checkbox", () => {
  function row(text: string): HTMLElement {
    const li = Array.from(
      document.querySelectorAll<HTMLElement>("ul > li")
    ).find((el) => el.textContent?.includes(text));
    if (!li) throw new Error(`row not found: ${text}`);
    return li;
  }

  /** The row's checkbox button (the bullet/disclosure is the other button). */
  function checkbox(text: string): HTMLButtonElement | null {
    return row(text).querySelector<HTMLButtonElement>("button[aria-pressed]");
  }

  it("shows a checkbox only on task rows, in the right state", async () => {
    render(<TaskHarness />);
    await waitFor(() => row("buy milk"));
    expect(checkbox("buy milk")!.getAttribute("aria-pressed")).toBe("false");
    expect(checkbox("buy bread")!.getAttribute("aria-pressed")).toBe("true");
    expect(checkbox("just a note")).toBeNull();
  });

  it("strikes a done row's text through", async () => {
    render(<TaskHarness />);
    const done = await waitFor(() =>
      row("buy bread").querySelector<HTMLElement>("span.line-through")
    );
    expect(done.textContent).toBe("buy bread");
    expect(
      row("buy milk").querySelector("span.line-through")
    ).toBeNull();
  });

  it("toggles on click without dragging the caret into the row", async () => {
    render(<TaskHarness />);
    await waitFor(() => row("buy milk"));
    await userEvent.click(checkbox("buy milk")!);
    await waitFor(() => findNode(engine().model, "open")?.checked === true);
    // The click is a toggle, not a row activation.
    expect(engine().state.view.editing).toBe(false);

    await userEvent.click(checkbox("buy milk")!);
    await waitFor(() => findNode(engine().model, "open")?.checked === false);
  });

  it("keeps the checkbox out of the keyboard's way", async () => {
    // The keyboard-escape invariant is about text fields; the box is a pointer
    // affordance only, so it must never take focus (see CLAUDE.md).
    render(<TaskHarness />);
    await waitFor(() => row("buy milk"));
    expect(checkbox("buy milk")!.tabIndex).toBe(-1);
  });
});
