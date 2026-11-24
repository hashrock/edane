import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  type EditorPreferences,
} from "../application/editorPreferences";

// ノードの右クリックメニュー: 項目の横に、同じことをするキーを出す（キーは今の
// 設定で組み立てたキーマップから読むので、実際に発火するキーだけが出る）。
// タッチ端末では長押しで同じメニューが開く。

const ROOTS: MindMapModel[] = [
  {
    id: "top",
    text: "Top",
    children: [
      { id: "a", text: "alpha", children: [] },
      { id: "b", text: "beta", children: [] },
      { id: "c", text: "gamma", children: [] },
    ],
  },
];

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

const canvasEl = () =>
  document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;

function setup(prefs: Partial<EditorPreferences> = {}) {
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ ...DEFAULT_PREFERENCES, ...prefs })
  );
  render(
    <MindmapEditor
      initialContent={JSON.stringify({ version: 2, roots: ROOTS })}
      initialTitle="Menu"
    />
  );
}

/**
 * Viewport coordinates of a node's click point — once the Konva stage has
 * drawn the nodes (their event handlers are bound by that redraw; on a slow
 * CI runner the layout point is known well before it).
 */
async function nodePoint(id: string) {
  await waitFor(
    () =>
      canvasEl().querySelector("canvas") &&
      api().getRedrawStats().redrawCount > 0
  );
  const p = await waitFor(() => api().getNodeClickPoint(id));
  const rect = canvasEl().getBoundingClientRect();
  return { x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) };
}

/**
 * Right-click a node and wait for ITS menu. On CI the first tests can fire
 * before the stage has settled (fonts loading reflow the layout after the
 * first draw), so the click point is re-read and the click re-sent until the
 * node's menu opens.
 */
async function rightClickNode(id: string) {
  const start = Date.now();
  for (;;) {
    const { x, y } = await nodePoint(id);
    const el = canvasEl();
    (el.querySelector("canvas") ?? el).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      })
    );
    for (let i = 0; i < 10; i++) {
      // A node's menu, not the empty-canvas one (a click that landed beside
      // the node while the stage was still settling).
      if (menuButton("Copy branch as text")) return;
      if (menuButtons().length > 0) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await waitFor(() => menuButtons().length === 0);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (Date.now() - start > 8000) throw new Error(`rightClickNode(${id}): no node menu`);
  }
}

function touch(type: string, x: number, y: number, lifted = false) {
  const el = canvasEl().querySelector("canvas") ?? canvasEl();
  const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
  el.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: lifted ? [] : [t],
      targetTouches: lifted ? [] : [t],
      changedTouches: [t],
    })
  );
}

const menuButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => b.closest(".fixed.z-50")
  );
const menuButton = (label: string) =>
  menuButtons().find((b) => b.textContent?.startsWith(label));
/** The key hint printed on a menu item ("" when the item has none). */
const hintOf = (label: string) =>
  menuButton(label)?.querySelector('[data-testid="menu-shortcut"]')?.textContent ?? "";
const mod = /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`)
  ? "⌘"
  : "Ctrl";

beforeEach(() => {
  localStorage.clear();
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 600px;
    }
  `;
  document.head.appendChild(style);
});

describe("context menu key hints", () => {
  it("shows the keys the current keymap fires", async () => {
    setup();
    await rightClickNode("b");
    await waitFor(() => menuButton("Add child node"));
    expect(hintOf("Edit text")).toBe("Space");
    expect(hintOf("Add child node")).toBe("Tab");
    expect(hintOf("Add item at the same level")).toBe("Enter");
    expect(hintOf("Move node up")).toBe("Alt + ↑");
    expect(hintOf("Move node down")).toBe("Alt + ↓");
    expect(hintOf("Indent")).toBe("Alt + →");
    expect(hintOf("Outdent")).toBe("Shift + Tab");
    expect(hintOf("Bold")).toBe(`${mod} + B`);
    expect(hintOf("Delete node")).toBe("Backspace");
    expect(hintOf("Keyboard shortcuts")).toBe("?");
  });

  it("follows the preferences (Enter edits, Tab indents)", async () => {
    setup({ enterBehavior: "edit", tabBehavior: "indent" });
    await rightClickNode("b");
    await waitFor(() => menuButton("Add child node"));
    expect(hintOf("Edit text")).toBe("Enter");
    expect(hintOf("Add item at the same level")).toBe(`${mod} + Enter`);
    // Tab indents now, so nothing on the keyboard adds a child.
    expect(hintOf("Add child node")).toBe("");
    expect(hintOf("Indent")).toBe("Tab");
  });

  it("menu items do what their key does, on the clicked node", async () => {
    setup();
    await rightClickNode("c");
    (await waitFor(() => menuButton("Move node up"))).click();
    await waitFor(() =>
      api().getModel().roots[0].children.map((n) => n.id).join() === "a,c,b"
    );
    expect(api().getActiveNodeId()).toBe("c");

    await rightClickNode("c");
    (await waitFor(() => menuButton("Indent"))).click();
    await waitFor(() => api().getModel().roots[0].children[0].children[0]?.id === "c");
  });

  it("offers no move-up on the first sibling", async () => {
    setup();
    await rightClickNode("a");
    await waitFor(() => menuButton("Add child node"));
    expect(menuButton("Move node up")).toBeUndefined();
    expect(menuButton("Indent")).toBeUndefined();
    expect(menuButton("Move node down")).toBeDefined();
  });

  it("opens the shortcut list", async () => {
    setup();
    await rightClickNode("a");
    (await waitFor(() => menuButton("Keyboard shortcuts"))).click();
    await waitFor(() =>
      Array.from(document.querySelectorAll("h2")).some(
        (h) => h.textContent === "Keyboard shortcuts"
      )
    );
  });
});

describe("long press (touch)", () => {
  it("holding a finger on a node opens its menu", async () => {
    setup();
    const { x, y } = await nodePoint("b");
    touch("touchstart", x, y);
    await new Promise((r) => setTimeout(r, 700));
    touch("touchend", x, y, true);
    await waitFor(() => menuButton("Add child node"));
    // The menu is the node's: deleting from it removes "b".
    menuButton("Delete node")!.click();
    await waitFor(() => !api().getModel().roots[0].children.some((n) => n.id === "b"));
  });

  it("a short tap or a moving finger does not", async () => {
    setup();
    const { x, y } = await nodePoint("b");
    touch("touchstart", x, y);
    await new Promise((r) => setTimeout(r, 100));
    touch("touchend", x, y, true);
    touch("touchstart", x, y);
    touch("touchmove", x + 40, y);
    await new Promise((r) => setTimeout(r, 700));
    touch("touchend", x + 40, y, true);
    expect(menuButton("Add child node")).toBeUndefined();
  });

  it("holding on empty canvas offers a new tree there", async () => {
    setup();
    await nodePoint("a"); // wait for the stage
    const rect = canvasEl().getBoundingClientRect();
    const x = Math.round(rect.left + 850);
    const y = Math.round(rect.top + 560);
    touch("touchstart", x, y);
    await new Promise((r) => setTimeout(r, 700));
    touch("touchend", x, y, true);
    await waitFor(() => menuButton("Add root here"));
  });
});
