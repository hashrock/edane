/**
 * Cross-node text selection (application/textRange.ts) in the real editors:
 * Shift+arrows past a node's edge extend the selection into the next node,
 * Cmd/Ctrl+C copies it as indented lines, a plain arrow ends it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import type { MindMapModel } from "../domain/model";

// Flat order: a, a1, b.
const ROOTS: MindMapModel[] = [
  { id: "a", text: "Alpha", children: [{ id: "a1", text: "One", children: [] }] },
  { id: "b", text: "Bravo", children: [] },
];
const CONTENT = JSON.stringify({ version: 2, roots: ROOTS });

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

/** Fire a copy on the editor's textarea and return what it put on the clipboard. */
function copyFrom(el: HTMLElement): string {
  const dt = new DataTransfer();
  el.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData("text/plain");
}

describe("cross-node selection on the canvas", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.textContent = `[data-testid="mm-canvas"] { position: absolute; left: 0; top: 0; width: 800px; height: 560px; }`;
    document.head.appendChild(style);
  });

  const api = (): MindmapTestApi => {
    if (!window.__mindmapTest) throw new Error("not ready");
    return window.__mindmapTest;
  };
  const input = () => document.querySelector<HTMLTextAreaElement>('textarea[style*="caret-color"]')!;

  it("Shift+↓ extends into the next nodes and Cmd+C copies indented lines", async () => {
    render(<MindmapEditor initialContent={CONTENT} initialTitle="T" />);
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    input().focus();

    // Space edits "a" (caret at its start); two lines down, three characters on.
    await userEvent.keyboard(" ");
    await waitFor(() => api().getSelection().editing);
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");

    // The textarea still edits "a" and selects its part of the range.
    expect(api().getSelection()).toMatchObject({ activeNodeId: "a", cursorPos: 0, selectionEnd: 5, editing: true });
    expect(copyFrom(input())).toBe("Alpha\n  One\nBra");
    // Nothing was edited along the way.
    expect(api().getModel().roots.map((r) => r.text)).toEqual(["Alpha", "Bravo"]);

    // → ends the range at its end: the caret is in "b" after "Bra".
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => api().getActiveNodeId() === "b");
    expect(api().getSelection()).toMatchObject({ cursorPos: 3, selectionEnd: 3, editing: true });
  });

  async function editA() {
    render(<MindmapEditor initialContent={CONTENT} initialTitle="T" />);
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    input().focus();
    await userEvent.keyboard(" ");
    await waitFor(() => api().getSelection().editing);
  }

  it("typing over a live range replaces it, and typing goes on at the caret", async () => {
    await editA();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}xy");
    await waitFor(() => api().getModel().roots[0].text === "xyOne");
    expect(api().getModel().roots[0].children).toEqual([]);
    expect(api().getSelection()).toMatchObject({ activeNodeId: "a", cursorPos: 2, editing: true });
  });

  it("cut copies the range and deletes it; paste replaces it", async () => {
    await editA();
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{/Shift}");
    const dt = new DataTransfer();
    input().dispatchEvent(new ClipboardEvent("cut", { clipboardData: dt, bubbles: true, cancelable: true }));
    expect(dt.getData("text/plain")).toBe("Alpha\n  On");
    await waitFor(() => api().getModel().roots[0].text === "e");

    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const paste = new DataTransfer();
    paste.setData("text/plain", "Z");
    input().dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
    // The range ("|e" … "|Bravo") is replaced by the pasted text in one step.
    await waitFor(() => api().getModel().roots.length === 1);
    expect(api().getModel().roots[0].text).toBe("ZBravo");
    expect(api().getSelection()).toMatchObject({ cursorPos: 1, selectionEnd: 1 });
  });
});

describe("cross-node selection in the outline", () => {
  function Harness() {
    const engine = useNoteEditor({ initialContent: CONTENT, initialTitle: "T" });
    (window as unknown as { __engine?: NoteEditorEngine }).__engine = engine;
    return <OutlineEditor engine={engine} />;
  }
  const engine = () => {
    const e = (window as unknown as { __engine?: NoteEditorEngine }).__engine;
    if (!e) throw new Error("not ready");
    return e;
  };

  it("highlights the covered part of the other rows and copies the range", async () => {
    render(<Harness />);
    const alpha = await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLElement>("ul > li")).find((li) => li.textContent?.includes("Alpha"))
    );
    await userEvent.click(alpha.querySelector(".cursor-text")!);
    await waitFor(() => engine().state.view.activeNodeId === "a");
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>("textarea"));
    await userEvent.click(ta);
    await userEvent.keyboard("{Home}{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{/Shift}");

    await waitFor(() => engine().state.view.textRange);
    const marks = Array.from(document.querySelectorAll('[data-testid="range-highlight"]'));
    expect(marks.map((m) => m.textContent)).toEqual(["On"]);
    expect(copyFrom(ta)).toBe("Alpha\n  On");

    // Shrinking back into "a" turns it into an ordinary in-node selection.
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await waitFor(() => engine().state.view.textRange?.focus.id === "a");
    expect(document.querySelectorAll('[data-testid="range-highlight"]').length).toBe(0);
  });
});
