/**
 * 枝のスキーマのエディタ側動線（browser e2e）:
 *  - canvas: 右クリック「Set schema…」→ フィールド行を足して保存 → ノードに載る
 *  - テキストタブ: 行と同じ内容を書式で見せ、不正なら保存できない
 *  - canvas: スキーマのある枝でレコードを Enter で作ると、型付きの空フィールドが付く
 *  - outline: フィールド名のラベルと、型が合わないノードの ⚠
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor } from "./useNoteEditor";
import { findNode, type MindMapModel } from "../domain/model";

const ROOTS: MindMapModel[] = [
  {
    id: "books",
    text: "Books",
    children: [
      {
        id: "a",
        text: "Book A",
        children: [
          { id: "a0", text: "Alice", children: [] },
          { id: "a1", text: "not an image", children: [] },
        ],
      },
    ],
  },
];
const content = (roots: MindMapModel[]) => JSON.stringify({ version: 2, roots });

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

function rightClickNode(id: string) {
  const pt = api().getNodeClickPoint(id);
  if (!pt) throw new Error(`node ${id} not visible`);
  document.querySelector(".konvajs-content canvas")!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y })
  );
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) ?? null;

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `[data-testid="mm-canvas"] { position: absolute; left: 0; top: 0; width: 900px; height: 600px; }`;
  document.head.appendChild(style);
});

describe("branch schema (canvas)", () => {
  it("context menu → dialog sets the schema; Enter on a record then brings typed blank fields", async () => {
    render(<MindmapEditor initialContent={content(ROOTS)} initialTitle="Shelf" />);
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    rightClickNode("books");
    (await waitFor(() => button("Set schema"))).click();
    // Fields tab: add three rows, then name and type them.
    const add = await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid="schema-add"]'));
    add.click();
    add.click();
    add.click();
    const keys = await waitFor(() => {
      const k = document.querySelectorAll<HTMLInputElement>('[data-testid="schema-key"]');
      return k.length === 3 ? k : null;
    });
    // A blank key blocks saving.
    expect(document.querySelector<HTMLButtonElement>('[data-testid="schema-save"]')!.disabled).toBe(true);
    await userEvent.fill(keys[0], "author");
    await userEvent.fill(keys[1], "cover");
    await userEvent.fill(keys[2], "done");
    const kinds = [...document.querySelectorAll('[data-testid="schema-kind"]')] as HTMLElement[];
    await userEvent.selectOptions(kinds[1], "image");
    await userEvent.selectOptions(kinds[2], "check");
    (await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid="schema-save"]:not([disabled])'))).click();
    await waitFor(() => findNode(api().getModel(), "books")?.schema === "author, cover:image, done:check");
    expect(document.querySelector('[data-testid="schema-key"]')).toBeNull();

    // Select the record and add a sibling record (Enter in selection mode).
    const p = await waitFor(() => api().getNodeClickPoint("a"));
    await userEvent.click(document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!, {
      position: { x: Math.round(p.x), y: Math.round(p.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    await userEvent.keyboard("{Enter}");
    const records = await waitFor(() => {
      const r = findNode(api().getModel(), "books")!.children;
      return r.length === 2 ? r : null;
    });
    expect(api().getActiveNodeId()).toBe(records[1].id);
    expect(records[1].children.map((c) => [c.text, c.type ?? "text", c.checked])).toEqual([
      ["", "text", undefined],
      ["", "image", undefined],
      ["", "text", false],
    ]);
    // The record that was already there keeps its two children.
    expect(records[0].children).toHaveLength(2);
  });

  it("the text tab mirrors the rows and rejects an invalid schema", async () => {
    const roots: MindMapModel[] = [{ ...ROOTS[0], schema: "author, page:number" }];
    render(<MindmapEditor initialContent={content(roots)} initialTitle="Shelf" />);
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    rightClickNode("books");
    (await waitFor(() => button("Set schema"))).click();
    await waitFor(() => document.querySelectorAll('[data-testid="schema-row"]').length === 2);
    (await waitFor(() => button("Text"))).click();
    const input = await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid="schema-input"]'));
    expect(input.value).toBe("author, page:number");
    await userEvent.fill(input, "a:bool");
    await waitFor(() => document.querySelector('[data-testid="schema-error"]'));
    expect(document.querySelector<HTMLButtonElement>('[data-testid="schema-save"]')!.disabled).toBe(true);
    // Fixing the text and switching back rebuilds the rows from it.
    await userEvent.fill(input, "x:date, y");
    button("Fields")!.click();
    const keys = await waitFor(() => {
      const k = [...document.querySelectorAll<HTMLInputElement>('[data-testid="schema-key"]')].map((e) => e.value);
      return k.length === 2 ? k : null;
    });
    expect(keys).toEqual(["x", "y"]);
  });
});

describe("branch schema (outline)", () => {
  it("labels field rows and marks the one that isn't its type", async () => {
    const roots: MindMapModel[] = [{ ...ROOTS[0], schema: "author, cover:image" }];
    function Harness() {
      const engine = useNoteEditor({ initialContent: content(roots), initialTitle: "Shelf" });
      return <OutlineEditor engine={engine} />;
    }
    render(<Harness />);
    const labels = await waitFor(() => {
      const l = [...document.querySelectorAll('[data-testid="schema-label"]')].map((e) => e.textContent);
      return l.length === 2 ? l : null;
    });
    expect(labels).toEqual(["author", "⚠ cover"]);
  });
});
