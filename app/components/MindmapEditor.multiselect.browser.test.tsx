import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import { findNode, type MindMapModel } from "../domain/model";

// 複数選択（#171）が実際のポインタ操作で成立すること: ボタンを離しても選択が
// 生き残ること、そしてチェックボックス操作（箱のクリック・右クリックメニュー）
// が選択されたノード全部に効くこと。

// タスクは1つの top-level ノードにぶら下げる（ルートは濃色の別レイアウトで、
// 最初のルートが初期選択になるため）。
function model(children: MindMapModel[]): MindMapModel {
  return {
    id: "root",
    text: "Shopping",
    children: [{ id: "list", text: "groceries", children }],
  };
}

/** 3つともタスク（未完了）。 */
const TASKS = model([
  { id: "a", text: "buy milk", checked: false, children: [] },
  { id: "b", text: "buy bread", checked: false, children: [] },
  { id: "c", text: "buy eggs", checked: false, children: [] },
]);

/** 3つとも子を持つ（折りたたみの一括操作用）。 */
const PARENTS = model([
  { id: "a", text: "milk", children: [{ id: "a1", text: "2L", children: [] }] },
  { id: "b", text: "bread", children: [{ id: "b1", text: "rye", children: [] }] },
  { id: "c", text: "eggs", children: [{ id: "c1", text: "dozen", children: [] }] },
]);

/** 混在: チェックボックスの無いメモ2つと、完了済みタスク1つ。 */
const MIXED = model([
  { id: "a", text: "milk", children: [] },
  { id: "b", text: "bread", children: [] },
  { id: "c", text: "eggs", checked: true, children: [] },
]);

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

function canvas(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

function setup(root: MindMapModel) {
  render(
    <MindmapEditor
      initialContent={JSON.stringify({ version: 2, roots: root.children })}
      initialTitle="Shopping"
    />
  );
}

async function clickNode(id: string, modifier?: "Meta" | "Shift") {
  const p = await waitFor(() => api().getNodeClickPoint(id));
  if (modifier) await userEvent.keyboard(`{${modifier}>}`);
  await userEvent.click(canvas(), {
    position: { x: Math.round(p.x), y: Math.round(p.y) },
  });
  if (modifier) await userEvent.keyboard(`{/${modifier}}`);
}

/**
 * Select a…c as one range (a is clicked plainly first, so it is the anchor).
 * `size` is the whole flat-order range, children included.
 */
async function selectAll(size = 3) {
  await clickNode("a");
  await waitFor(() => api().getActiveNodeId() === "a");
  await clickNode("c", "Shift");
  await waitFor(() => selectedIds().length === size);
}

async function rightClickNode(id: string) {
  const p = await waitFor(() => api().getNodeClickPoint(id));
  const el = canvas();
  const target = el.querySelector("canvas") ?? el;
  // getNodeClickPoint is stage-relative; a MouseEvent carries viewport
  // coordinates, so add where the canvas actually sits.
  const rect = el.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.left + p.x),
      clientY: Math.round(rect.top + p.y),
    })
  );
}

const menuButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.includes(label)
  );

async function menuClick(label: string) {
  const btn = await waitFor(() => menuButton(label));
  btn.click();
}

function selectedIds(): readonly string[] {
  return api().getSelection().selectedIds;
}

function checkedOf(id: string): boolean | undefined {
  return findNode(api().getModel(), id)?.checked;
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 600px;
    }
  `;
  document.head.appendChild(style);
});

describe("multi-selection (browser e2e)", () => {
  it("keeps a Cmd+click selection after the pointer is released", async () => {
    setup(TASKS);
    await clickNode("a");
    await waitFor(() => api().getActiveNodeId() === "a");

    await clickNode("b", "Meta");
    // ボタンを離した後も生き残る（React の onSelect が mouseup で走っても）。
    await waitFor(() => selectedIds().length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect([...selectedIds()].sort()).toEqual(["a", "b"]);
  });

  it("keeps a Shift+click range after the pointer is released", async () => {
    setup(TASKS);
    await selectAll();
    await new Promise((r) => setTimeout(r, 100));
    expect([...selectedIds()].sort()).toEqual(["a", "b", "c"]);
  });

  it("toggles every selected checkbox from one box click", async () => {
    setup(TASKS);
    await selectAll();

    const p = await waitFor(() => api().getCheckboxPoint("a"));
    await userEvent.click(canvas(), {
      position: { x: Math.round(p.x), y: Math.round(p.y) },
    });
    await waitFor(() => checkedOf("c") === true);
    for (const id of ["a", "b", "c"]) expect(checkedOf(id)).toBe(true);
  });

  it("drops the selection on a plain click", async () => {
    setup(TASKS);
    await selectAll();

    await clickNode("b");
    await waitFor(() => api().getActiveNodeId() === "b");
    expect(selectedIds()).toEqual([]);
  });
});

describe("multi-selection · right-click menu (browser e2e)", () => {

  it("'Add checkbox' gives one to every selected node without a box", async () => {
    setup(MIXED);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Add checkbox");
    await waitFor(() => checkedOf("b") === false);
    expect(checkedOf("a")).toBe(false);
    // 既にタスクだったノードは巻き込まれず、完了のまま。
    expect(checkedOf("c")).toBe(true);
  });

  it("'Mark as done' completes every selected task at once", async () => {
    setup(TASKS);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Mark as done");
    await waitFor(() => checkedOf("c") === true);
    for (const id of ["a", "b", "c"]) expect(checkedOf(id)).toBe(true);
  });

  it("'Remove checkbox' strips every selected task's box", async () => {
    setup(TASKS);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Remove checkbox");
    await waitFor(() => checkedOf("c") === undefined);
    for (const id of ["a", "b", "c"]) expect(checkedOf(id)).toBeUndefined();
  });

  it("converts every selected node's kind at once", async () => {
    setup(TASKS);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Convert to link (URL)");
    await waitFor(() => findNode(api().getModel(), "c")?.type === "link");
    for (const id of ["a", "b", "c"]) {
      expect(findNode(api().getModel(), id)?.type).toBe("link");
    }
  });

  it("bolds the whole selection, and unbolds it on the second pass", async () => {
    setup(TASKS);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Bold");
    await waitFor(() => findNode(api().getModel(), "c")?.bold === true);
    for (const id of ["a", "b", "c"]) {
      expect(findNode(api().getModel(), id)?.bold).toBe(true);
    }

    // 全部太字になったので、次は解除側のラベルが出る。
    await rightClickNode("a");
    await menuClick("Remove bold");
    await waitFor(() => findNode(api().getModel(), "c")?.bold === undefined);
    for (const id of ["a", "b", "c"]) {
      expect(findNode(api().getModel(), id)?.bold).toBeUndefined();
    }
  });

  it("folds every selected parent together", async () => {
    setup(PARENTS);
    await selectAll(5); // a, a1, b, b1, c — the children are in the range too

    await rightClickNode("a");
    await menuClick("Collapse");
    await waitFor(() => findNode(api().getModel(), "c")?.collapsed === true);
    for (const id of ["a", "b", "c"]) {
      expect(findNode(api().getModel(), id)?.collapsed).toBe(true);
    }
  });

  it("deletes every selected branch in one go", async () => {
    setup(TASKS);
    await selectAll();

    await rightClickNode("a");
    await menuClick("Delete");
    await waitFor(() => findNode(api().getModel(), "a") === null);
    for (const id of ["a", "b", "c"]) {
      expect(findNode(api().getModel(), id)).toBeNull();
    }
    // 消えたノードを指す選択は残らない。
    expect(selectedIds()).toEqual([]);
  });

  it("copies one block per selected branch, in document order", async () => {
    setup(PARENTS);
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => void writes.push(text) },
      configurable: true,
    });
    await selectAll(5);

    await rightClickNode("a");
    await menuClick("Copy branch as text");
    await waitFor(() => writes.length === 1);
    // 親と、その中の子の両方を選んでいても、子の行は親のブロックに一度だけ。
    expect(writes[0]).toBe("milk\n  2L\nbread\n  rye\neggs\n  dozen");
  });

  it("stays single-node when the right-clicked node isn't in the selection", async () => {
    setup(TASKS);
    await clickNode("a");
    await clickNode("b", "Meta");
    await waitFor(() => selectedIds().length === 2);

    await rightClickNode("c");
    await menuClick("Mark as done");
    await waitFor(() => checkedOf("c") === true);
    expect(checkedOf("a")).toBe(false);
    expect(checkedOf("b")).toBe(false);
  });
});
