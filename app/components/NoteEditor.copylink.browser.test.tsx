import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import NoteEditor from "./NoteEditor";
import type { MindMapModel } from "../domain/model";

/**
 * エディタ（canvas / outline の両レイアウト）から公開ノートのリンクをコピーする
 * 動線。公開状態の切り替えと同じメニュー（PublicityDropdown）に同居している。
 */

const MODEL: MindMapModel = { id: "root", text: "Root", children: [] };
const NOTE_ID = "note-1";

const restores: (() => void)[] = [];

function stubClipboard(written: string[]) {
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (t: string) => {
        written.push(t);
      },
    },
    configurable: true,
  });
  restores.push(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    if (desc) Object.defineProperty(Navigator.prototype, "clipboard", desc);
  });
}

/** noteId 付きで描くとオートセーブが走るので、成功扱いで握りつぶす。 */
function stubFetch() {
  const prev = window.fetch;
  window.fetch = (async () =>
    new Response("{}", { status: 200 })) as typeof window.fetch;
  restores.push(() => {
    window.fetch = prev;
  });
}

async function waitFor(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const copyItem = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="copy-link"]');
const status = () =>
  document.querySelector('[data-testid="save-status"]')?.textContent ?? "";

/** 公開／非公開のドロップダウンを開く（トリガーはラベルに公開状態を出す）。 */
async function openPublicityMenu() {
  const trigger = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[popovertarget]")
  ).find((b) => /\b(Public|Private)\b/.test(b.textContent ?? ""));
  if (!trigger) throw new Error("publicity trigger not found");
  trigger.click();
  await waitFor(() => copyItem() !== null);
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] { position: absolute; left: 0; top: 0; width: 800px; height: 560px; }
  `;
  document.head.appendChild(style);
  restores.push(() => style.remove());
  stubFetch();
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe("NoteEditor リンクをコピー (browser e2e)", () => {
  it("copies the absolute /notes/:id URL from the canvas layout", async () => {
    const written: string[] = [];
    stubClipboard(written);
    await page.viewport(1280, 800);
    render(
      <NoteEditor
        noteId={NOTE_ID}
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={true}
      />
    );
    await waitFor(() => document.querySelector('[data-testid="mm-canvas"]') !== null);

    await openPublicityMenu();
    expect(copyItem()!.disabled).toBe(false);
    copyItem()!.click();

    await waitFor(() => written.length > 0);
    expect(written).toEqual([`${window.location.origin}/notes/${NOTE_ID}`]);
    // フィードバックはヘッダーの既存ステータス行に相乗りする。
    await waitFor(() => status() === "Link copied");
  });

  it("offers the same action in the outline layout", async () => {
    const written: string[] = [];
    stubClipboard(written);
    // 狭いビューポートでは outline レイアウトになる。
    await page.viewport(600, 800);
    render(
      <NoteEditor
        noteId={NOTE_ID}
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={true}
      />
    );
    await waitFor(
      () => document.querySelector('[data-testid="outline-view"]') !== null
    );

    await openPublicityMenu();
    copyItem()!.click();
    await waitFor(() => written.length > 0);
    expect(written).toEqual([`${window.location.origin}/notes/${NOTE_ID}`]);
    await waitFor(() => status() === "Link copied");
  });

  it("disables the action with a reason while the note is private", async () => {
    const written: string[] = [];
    stubClipboard(written);
    await page.viewport(1280, 800);
    render(
      <NoteEditor
        noteId={NOTE_ID}
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={false}
      />
    );
    await waitFor(() => document.querySelector('[data-testid="mm-canvas"]') !== null);

    await openPublicityMenu();
    const item = copyItem()!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("Private notes can't be shared");
    item.click();
    expect(written).toEqual([]);
  });

  it("reports failure instead of staying silent when the clipboard is unavailable", async () => {
    // 非セキュアコンテキスト + execCommand も不可、という最悪ケース。
    const desc = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      "clipboard"
    );
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const prevExec = document.execCommand;
    document.execCommand = (() => false) as typeof document.execCommand;
    restores.push(() => {
      document.execCommand = prevExec;
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      if (desc) Object.defineProperty(Navigator.prototype, "clipboard", desc);
    });

    await page.viewport(1280, 800);
    render(
      <NoteEditor
        noteId={NOTE_ID}
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={true}
      />
    );
    await waitFor(() => document.querySelector('[data-testid="mm-canvas"]') !== null);

    await openPublicityMenu();
    copyItem()!.click();
    await waitFor(() => status() === "Couldn't copy");
  });
});
