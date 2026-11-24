import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import EditorSettingsDialog from "./EditorSettingsDialog";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
  type EditorPreferences,
} from "../application/editorPreferences";
import { findNode, type MindMapModel } from "../domain/model";

// 設定ダイアログでショートカットキーを変える: 「変更」を押して次に押したキーを
// 記録し、設定（localStorage）に保存する。危ないキー・使用中のキーは理由を出して
// 断る。保存したキーでエディタが動き、右クリックメニューの表示も変わる。

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

const closes: number[] = [];

function Harness() {
  const [prefs, setPrefs] = useState<EditorPreferences>(() => loadPreferences());
  return (
    <EditorSettingsDialog
      open
      prefs={prefs}
      onChange={(next) => {
        setPrefs(next);
        savePreferences(next);
      }}
      onClose={() => closes.push(1)}
    />
  );
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-key-id="${id}"]`)!;
const rowKeys = (id: string) => row(id).querySelector("kbd")?.textContent ?? "";
const rowButton = (id: string, label: string) =>
  Array.from(row(id).querySelectorAll("button")).find((b) => b.textContent === label)!;
const stored = () => loadPreferences().customKeys;
const mod = /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`)
  ? "⌘"
  : "Ctrl";

beforeEach(() => {
  localStorage.removeItem(PREFERENCES_KEY);
  closes.length = 0;
});
afterEach(() => localStorage.removeItem(PREFERENCES_KEY));

describe("shortcut keys in the settings dialog", () => {
  it("records the next key and saves it", async () => {
    render(<Harness />);
    await waitFor(() => row("bold"));
    expect(rowKeys("bold")).toBe(`${mod} + B`);
    rowButton("bold", "Change").click();
    await waitFor(() => row("bold").querySelector('[role="status"]'));
    await userEvent.keyboard("{Control>}j{/Control}");
    await waitFor(() => rowKeys("bold") === `${mod} + J`);
    expect(stored()).toEqual({ bold: { key: "j", mod: true, shift: false, alt: false } });

    rowButton("bold", "Reset").click();
    await waitFor(() => rowKeys("bold") === `${mod} + B`);
    expect(stored()).toEqual({});
  });

  it("refuses a taken or unsafe key with a reason, and keeps listening", async () => {
    render(<Harness />);
    await waitFor(() => row("bold"));
    rowButton("bold", "Change").click();
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() => row("bold").querySelector('[role="alert"]')?.textContent?.includes("Command palette"));
    await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
    await waitFor(() => row("bold").querySelector('[role="alert"]')?.textContent?.includes("can't be assigned"));
    expect(stored()).toEqual({});
    // Escape stops recording without closing the dialog.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => !row("bold").querySelector('[role="status"]'));
    expect(closes).toEqual([]);
    expect(rowKeys("bold")).toBe(`${mod} + B`);
  });
});

describe("a saved key drives the editor", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.textContent = `
      [data-testid="mm-canvas"] {
        position: absolute; left: 0; top: 0; width: 900px; height: 600px;
      }
    `;
    document.head.appendChild(style);
  });
  const ROOTS: MindMapModel[] = [
    { id: "a", text: "Alpha", children: [{ id: "a1", text: "Child", children: [] }] },
  ];

  it("the new key works, the old one doesn't, and the menu shows it", async () => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      customKeys: { bold: { key: "j", mod: true, shift: false, alt: false } },
    });
    render(
      <MindmapEditor
        initialContent={JSON.stringify({ version: 2, roots: ROOTS })}
        initialTitle="Keys"
      />
    );
    const api = (): MindmapTestApi => window.__mindmapTest!;
    await waitFor(() => api()?.getActiveNodeId() === "a");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);
    const canvas = document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
    // Select the child with a real click so the editor holds the keyboard.
    const c = await waitFor(() => api().getNodeClickPoint("a1"));
    await userEvent.click(canvas, { position: { x: Math.round(c.x), y: Math.round(c.y) } });
    await waitFor(() => api().getActiveNodeId() === "a1");
    const bold = () => findNode(api().getModel(), "a1")?.bold === true;

    await userEvent.keyboard("{Control>}b{/Control}");
    await new Promise((r) => setTimeout(r, 100));
    expect(bold()).toBe(false);
    await userEvent.keyboard("{Control>}j{/Control}");
    await waitFor(bold);

    const p = await waitFor(() => api().getNodeClickPoint("a1"));
    const rect = canvas.getBoundingClientRect();
    (canvas.querySelector("canvas") ?? canvas).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: Math.round(rect.left + p.x),
        clientY: Math.round(rect.top + p.y),
      })
    );
    const item = await waitFor(() =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Remove bold"))
    );
    expect(item.querySelector('[data-testid="menu-shortcut"]')?.textContent).toBe(`${mod} + J`);
  });
});
