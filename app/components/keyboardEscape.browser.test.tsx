import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import { EDIT_SURFACE, type EditorLayout } from "../application/editSurface";
import type { MindMapModel, NodeType } from "../domain/model";

/**
 * THE KEYBOARD-ESCAPE INVARIANT, verified against the real DOM:
 *
 *   While a node is being edited — whatever node type, whatever editor layout,
 *   wherever the focus actually lives (shared textarea, URL box, …) — a
 *   bounded number of unmodified ArrowDown presses must reach the NEXT node,
 *   and ArrowUp presses the PREVIOUS node. The keyboard must never be trapped
 *   inside the editing field.
 *
 * The suite is generated from a fixture map keyed by NodeType (`satisfies`
 * keeps it exhaustive): adding a NodeType without deciding its arrow-key
 * behaviour fails to compile here and in EDIT_SURFACE. Keys are sent to
 * `document.activeElement` (that's what userEvent.keyboard does), so whichever
 * inner element stole the focus is exactly what gets tested.
 */

// --- Fixtures -------------------------------------------------------------

/** The middle node under test, one per NodeType. Multi-line / multi-row
 *  targets are deliberate: arrows should walk lines (and object-card rows)
 *  first and only then cross to the neighbour. */
const TARGETS = {
  text: {
    id: "target",
    text: "line one\nline two",
    children: [],
  },
  image: {
    id: "target",
    text: "https://example.com/x.png",
    type: "image",
    children: [],
  },
  link: {
    id: "target",
    text: "https://example.com/",
    type: "link",
    linkTitle: "Example",
    children: [],
  },
  markdown: {
    id: "target",
    text: "# Title\n\nSome body text",
    type: "markdown",
    children: [],
  },
  object: {
    id: "target",
    text: "商品A",
    type: "object",
    children: [
      { id: "row1", text: "価格: 1200", children: [] },
      { id: "row2", text: "在庫: 5", children: [] },
    ],
  },
} as const satisfies Record<NodeType, MindMapModel>;

const NODE_TYPES = Object.keys(TARGETS) as NodeType[];

function modelWith(target: MindMapModel): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      { id: "prev", text: "previous node", children: [] },
      target,
      { id: "next", text: "next node", children: [] },
    ],
  };
}

function countNodes(n: MindMapModel): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/** Upper bound on presses needed to escape: one per text line, one per
 *  descendant row (object cards), one to cross, plus slack. If this many
 *  presses don't reach the neighbour, the keyboard is trapped. */
function pressBudget(target: MindMapModel): number {
  const lines = target.text.split("\n").length;
  const rows = countNodes(target) - 1;
  return lines + rows + 3;
}

// --- Shared helpers --------------------------------------------------------

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Press `key` on whatever currently owns the focus until the active node is
 *  `wantId`, at most `budget` times; assert we got there. */
async function pressToReach(
  key: "{ArrowUp}" | "{ArrowDown}",
  wantId: string,
  budget: number,
  getActive: () => string | null
) {
  for (let i = 0; i < budget && getActive() !== wantId; i++) {
    await userEvent.keyboard(key);
    await sleep(50);
  }
  expect(getActive(), `${key} × ${budget} 回で ${wantId} に到達できず（閉じ込め）`).toBe(
    wantId
  );
}

// --- Canvas (MindmapEditor) -----------------------------------------------

function api(): MindmapTestApi {
  const a = window.__mindmapTest;
  if (!a) throw new Error("__mindmapTest not exposed yet");
  return a;
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

/** Render the canvas editor and put `target` into its edit state: click the
 *  plain-text "prev" node (stable even while images resize the layout), arrow
 *  down to the target, press Space. */
async function canvasEditTarget(target: MindMapModel) {
  render(
    <MindmapEditor
      initialContent={JSON.stringify(modelWith(target))}
      initialTitle="Root"
    />
  );
  await waitFor(() => api().getActiveNodeId() === "root");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  // Click "prev" with retries: an image target settling from "loading" to its
  // final size shifts the layout under the first click.
  for (let attempt = 0; attempt < 4; attempt++) {
    const rect = await waitFor(() => api().getNodeRect("prev"));
    await userEvent.click(canvas, {
      position: {
        x: Math.round(rect.x + 12),
        y: Math.round(rect.y + rect.height / 2),
      },
    });
    const start = Date.now();
    while (Date.now() - start < 1200) {
      if (api().getActiveNodeId() === "prev") break;
      await sleep(30);
    }
    if (api().getActiveNodeId() === "prev") break;
  }
  await waitFor(() => api().getActiveNodeId() === "prev");
  await userEvent.keyboard("{ArrowDown}");
  await waitFor(() => api().getActiveNodeId() === "target");
  await userEvent.keyboard("[Space]");
  // Markdown never edits on-canvas: edit intent opens the side panel and drops
  // back to selection mode. Everything else must now be editing.
  if (EDIT_SURFACE.canvas[target.type ?? "text"].kind === "modal-panel") {
    await waitFor(() => document.querySelector('[data-testid="md-panel"]'));
  } else {
    await waitFor(() => api().getSelection().editing === true);
  }
}

describe("keyboard-escape invariant — canvas (MindmapEditor)", () => {
  for (const type of NODE_TYPES) {
    const target = TARGETS[type];
    const budget = pressBudget(target);

    it(`${type}: 編集中の ArrowDown ${budget}回以内で次ノードへ到達する`, async () => {
      await canvasEditTarget(target);
      await pressToReach("{ArrowDown}", "next", budget, () =>
        api().getActiveNodeId()
      );
    });

    it(`${type}: 編集中の ArrowUp ${budget}回以内で前ノードへ到達する`, async () => {
      await canvasEditTarget(target);
      await pressToReach("{ArrowUp}", "prev", budget, () =>
        api().getActiveNodeId()
      );
    });
  }
});

// --- Outline (OutlineEditor, the mobile layout) -----------------------------

function OutlineHarness({ content }: { content: string }) {
  const engine = useNoteEditor({ initialContent: content, initialTitle: "Root" });
  (window as unknown as { __engine?: NoteEditorEngine }).__engine = engine;
  return <OutlineEditor engine={engine} />;
}

function engine(): NoteEditorEngine {
  const e = (window as unknown as { __engine?: NoteEditorEngine }).__engine;
  if (!e) throw new Error("engine not exposed yet");
  return e;
}

const outlineActive = () => engine().stateRef.current.view.activeNodeId;

/** Render the outline and click the target row's content to start editing.
 *  Rows are flat-ordered: root(0), prev(1), target(2). */
async function outlineEditTarget(target: MindMapModel) {
  render(<OutlineHarness content={JSON.stringify(modelWith(target))} />);
  const row = await waitFor(
    () => document.querySelectorAll<HTMLElement>("ul > li")[2]
  );
  await userEvent.click(row.querySelector<HTMLElement>(".cursor-text")!);
  await waitFor(
    () => outlineActive() === "target" && engine().stateRef.current.view.editing
  );
}

describe("keyboard-escape invariant — outline (OutlineEditor)", () => {
  for (const type of NODE_TYPES) {
    const target = TARGETS[type];
    const budget = pressBudget(target);

    it(`${type}: 編集中の ArrowDown ${budget}回以内で次ノードへ到達する`, async () => {
      await outlineEditTarget(target);
      await pressToReach("{ArrowDown}", "next", budget, outlineActive);
    });

    it(`${type}: 編集中の ArrowUp ${budget}回以内で前ノードへ到達する`, async () => {
      await outlineEditTarget(target);
      await pressToReach("{ArrowUp}", "prev", budget, outlineActive);
    });
  }
});

// Exhaustiveness cross-check: the EDIT_SURFACE table and this fixture map must
// cover exactly the same NodeTypes (both are `satisfies Record<NodeType, …>`,
// so this only fails if someone weakens one of those annotations).
describe("registry / fixture alignment", () => {
  it("EDIT_SURFACE covers every fixture type in both layouts", () => {
    for (const layout of ["canvas", "outline"] as EditorLayout[]) {
      for (const type of NODE_TYPES) {
        expect(EDIT_SURFACE[layout][type]).toBeDefined();
      }
    }
  });
});
