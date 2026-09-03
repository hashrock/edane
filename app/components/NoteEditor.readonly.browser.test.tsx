import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent, page } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor } from "./useNoteEditor";
import type { MindMapModel } from "../domain/model";

// 閲覧専用モード（readOnly）の検証:
// - どの操作でも編集モードに入らず、モデルが変わらないこと
// - 折りたたみ/展開だけは閲覧操作として動くこと

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "a",
      text: "Alpha",
      children: [{ id: "a1", text: "One", children: [] }],
    },
    { id: "b", text: "Bravo", children: [] },
    {
      id: "m",
      text: "# Doc\n\nbody text",
      type: "markdown",
      children: [],
    },
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
      // not ready yet
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

function findNode(node: MindMapModel, id: string): MindMapModel | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// The default 414px-wide test viewport can't reach clicks on the right of the
// canvas: the first tree is centred on open, so its toggle / second tree sit
// beyond x=414. Widen it like NoteEditor.browser.test.tsx does.
beforeEach(async () => {
  await page.viewport(1280, 800);
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

async function setupCanvas() {
  render(
    <MindmapEditor
      initialContent={JSON.stringify(MODEL)}
      initialTitle="Root"
      readOnly
    />
  );
  await waitFor(() => api().getActiveNodeId() === "a");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  const clickNode = async (id: string) => {
    const point = await waitFor(() => api().getNodeClickPoint(id));
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
  };
  return { canvas, clickNode };
}

describe("read-only mindmap view (browser e2e)", () => {
  it("clicking a node selects it but never enters edit mode; typing changes nothing", async () => {
    const { clickNode } = await setupCanvas();

    await clickNode("a");
    await waitFor(() => api().getActiveNodeId() === "a");
    expect(api().getSelection().editing).toBe(false);

    // 編集突入の各経路（Space / 直接タイプ / Enter）がすべて遮断される。
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard("x");
    await userEvent.keyboard("{Enter}");
    await new Promise((r) => setTimeout(r, 250));

    expect(api().getSelection().editing).toBe(false);
    const model = api().getModel();
    expect(findNode(model, "a")!.text).toBe("Alpha");
    expect(model.children.length).toBe(3);
  });

  it("double-click does not enter edit mode", async () => {
    const { canvas } = await setupCanvas();
    const point = await waitFor(() => api().getNodeClickPoint("b"));
    await userEvent.dblClick(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(api().getSelection().editing).toBe(false);
    expect(findNode(api().getModel(), "b")!.text).toBe("Bravo");
  });

  it("collapse / expand toggle still works as a viewing operation", async () => {
    const { canvas } = await setupCanvas();
    const btn = await waitFor(() => api().getToggleButtonPoint("a"));
    await userEvent.click(canvas, {
      position: { x: Math.round(btn.x), y: Math.round(btn.y) },
    });
    await waitFor(() => !!findNode(api().getModel(), "a")!.collapsed);

    const btn2 = await waitFor(() => api().getToggleButtonPoint("a"));
    await userEvent.click(canvas, {
      position: { x: Math.round(btn2.x), y: Math.round(btn2.y) },
    });
    await waitFor(() => !findNode(api().getModel(), "a")!.collapsed);
  });

  it("title is static text (no edit affordance) in the header", async () => {
    await setupCanvas();
    expect(document.querySelector('button[title="Edit title"]')).toBeNull();
  });

  it("clicking a markdown node opens the panel in view-only mode", async () => {
    const { clickNode } = await setupCanvas();
    await clickNode("m");
    await waitFor(() =>
      document.querySelector('[data-testid="md-panel"]')
    );
    const panel = document.querySelector('[data-testid="md-panel"]')!;
    // 表示/編集トグルは出ない（閲覧固定）。本文はレンダリングされている。
    const buttons = Array.from(panel.querySelectorAll("button")).map(
      (b) => b.textContent
    );
    expect(buttons).not.toContain("Edit");
    await waitFor(() =>
      panel.querySelector('[data-testid="md-panel-body"]')
    );
  });
});

/** OutlineEditor は engine を外から受けるので、readOnly エンジンを組んで渡す。 */
function ReadOnlyOutline() {
  const engine = useNoteEditor({
    initialContent: JSON.stringify(MODEL),
    initialTitle: "Root",
    readOnly: true,
  });
  return <OutlineEditor engine={engine} />;
}

describe("read-only outline view (browser e2e)", () => {
  it("hides the editing toolbar and never shows the row editor", async () => {
    render(<ReadOnlyOutline />);
    await waitFor(() => document.querySelector('[data-testid="outline-view"]'));

    // 下部の編集ツールバーが出ない。
    expect(document.querySelector('button[title="Add item"]')).toBeNull();
    expect(document.querySelector('button[title="Indent"]')).toBeNull();

    // 行をクリックしても編集用 textarea は現れない。
    const row = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "Alpha"
    )!;
    await userEvent.click(row);
    await new Promise((r) => setTimeout(r, 250));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("collapse toggle works from the outline bullets", async () => {
    render(<ReadOnlyOutline />);
    await waitFor(() => document.querySelector('[data-testid="outline-view"]'));

    const toggle = await waitFor(() =>
      document.querySelector('button[aria-label="Collapse"]')
    );
    await userEvent.click(toggle as Element);
    // 折りたたまれると子カウント "(1)" が表示され、ラベルが「展開」に変わる。
    await waitFor(() =>
      document.querySelector('button[aria-label="Expand"]')
    );
  });
});
