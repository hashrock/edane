/**
 * Selecting whole nodes from the keyboard on the canvas: Shift+↓ past a
 * node's last line leaves editing for a node selection, further Shift+↑/↓
 * grow or shrink it, and copy / cut / Delete act on every selected branch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Flat order: a, a1, b.
const ROOTS: MindMapModel[] = [
  { id: "a", text: "Alpha", children: [{ id: "a1", text: "One", children: [] }] },
  { id: "b", text: "Bravo", children: [] },
];

function api(): MindmapTestApi {
  if (!window.__mindmapTest) throw new Error("not ready");
  return window.__mindmapTest;
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

const input = () => document.querySelector<HTMLTextAreaElement>('textarea[style*="caret-color"]')!;

function clipboardEvent(type: "copy" | "cut"): DataTransfer {
  const dt = new DataTransfer();
  input().dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt;
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `[data-testid="mm-canvas"] { position: absolute; left: 0; top: 0; width: 800px; height: 560px; }`;
  document.head.appendChild(style);
});

async function editA() {
  render(<MindmapEditor initialContent={JSON.stringify({ version: 2, roots: ROOTS })} initialTitle="T" />);
  await waitFor(() => api().getActiveNodeId() === "a");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  input().focus();
  await userEvent.keyboard(" ");
  await waitFor(() => api().getSelection().editing);
}

describe("selecting whole nodes with Shift+↑/↓", () => {
  it("Shift+↓ leaves editing for a node selection that keeps growing; copy gives its branches as text", async () => {
    await editA();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getSelection().selectedIds.length === 2);
    expect(api().getSelection()).toMatchObject({ activeNodeId: "a", editing: false, selectedIds: ["a", "a1"] });

    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getSelection().selectedIds.length === 3);
    expect(clipboardEvent("copy").getData("text/plain")).toBe("Alpha\n  One\nBravo");

    // Shrinking back to the active node alone ends the selection.
    await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowUp}{/Shift}");
    await waitFor(() => api().getSelection().selectedIds.length === 0);
  });

  it("cut copies the selected branches and deletes them; so does Delete", async () => {
    await editA();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getSelection().selectedIds.length === 2);
    expect(clipboardEvent("cut").getData("text/plain")).toBe("Alpha\n  One");
    await waitFor(() => api().getModel().roots.every((r) => r.id !== "a"));
    expect(api().getModel().roots.map((r) => r.text)).toEqual(["Bravo"]);
  });

  it("Delete removes every selected branch", async () => {
    await editA();
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await waitFor(() => api().getSelection().selectedIds.length === 3);
    await userEvent.keyboard("{Delete}");
    // The last root can't go: a blank one takes its place.
    await waitFor(() => api().getModel().roots.length === 1 && api().getModel().roots[0].text === "");
  });
});
