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
