/**
 * ノードWeb公開（/pub/:id.json / .md）のエディタ側動線:
 *  - 右クリックメニュー「Web公開（JSON / Markdown）…」→ ダイアログが開き、
 *    POST /api/notes/:id/publications で発行されたIDから両URLを表示する
 *  - 「公開を解除」で DELETE が飛び、ダイアログが閉じる
 *  - ノートが非公開のときは発行せず（POSTしない）、理由を見せる
 *  - noteId の無いゲスト編集ではメニュー項目自体が出ない
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [{ id: "a", text: "Alpha", children: [] }],
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
      // not ready
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Konvaのステージ（.konvajs-content内のcanvas）へ contextmenu を撃つ。 */
function rightClickNode(id: string) {
  const pt = api().getNodeClickPoint(id);
  if (!pt) throw new Error(`node ${id} not visible`);
  const canvas = document.querySelector(".konvajs-content canvas");
  if (!canvas) throw new Error("konva canvas not found");
  canvas.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: pt.x,
      clientY: pt.y,
    })
  );
}

const menuItem = (label: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  ) ?? null;

const PUB_ID = "pub-123";
const realFetch = globalThis.fetch;
let requests: { url: string; method: string; body?: unknown }[] = [];

beforeEach(() => {
  requests = [];
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/publications") || url.includes("/api/notes")) {
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    }
    if (url.includes("/publications") && method === "POST") {
      return new Response(
        JSON.stringify({ id: PUB_ID, nodeId: "a", createdAt: "2026-08-21" }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes(`/api/publications/${PUB_ID}`) && method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/notes/") && method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("node web publication (browser e2e)", () => {
  it("context menu → dialog issues a publication and shows both URLs; revoke DELETEs", async () => {
    render(
      <MindmapEditor
        noteId="note-1"
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={true}
      />
    );
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    rightClickNode("a");
    const item = await waitFor(() => menuItem("Publish to web"));
    item.click();

    // ダイアログが発行APIを叩き、返ってきたIDでJSON/Markdown両URLを出す
    const jsonInput = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>('[data-testid="pub-url-json"]')
    );
    expect(jsonInput.value).toBe(`${window.location.origin}/pub/${PUB_ID}.json`);
    const mdInput = document.querySelector<HTMLInputElement>(
      '[data-testid="pub-url-md"]'
    );
    expect(mdInput?.value).toBe(`${window.location.origin}/pub/${PUB_ID}.md`);

    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toContain("/api/notes/note-1/publications");
    expect(post?.body).toEqual({ nodeId: "a" });

    // 公開を解除 → DELETE が飛んでダイアログが閉じる
    const revoke = await waitFor(() => menuItem("Unpublish"));
    revoke.click();
    await waitFor(() =>
      requests.some(
        (r) => r.method === "DELETE" && r.url.includes(`/api/publications/${PUB_ID}`)
      )
    );
    await waitFor(
      () => !document.querySelector('[data-testid="pub-url-json"]')
    );
  });

  it("private note: shows the reason instead of issuing a URL (no POST)", async () => {
    render(
      <MindmapEditor
        noteId="note-1"
        initialContent={JSON.stringify(MODEL)}
        initialTitle="Root"
        initialIsPublic={false}
      />
    );
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    rightClickNode("a");
    const item = await waitFor(() => menuItem("Publish to web"));
    item.click();

    await waitFor(() =>
      document.body.textContent?.includes("Nodes of a private note can't be published")
    );
    expect(document.querySelector('[data-testid="pub-url-json"]')).toBeNull();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("guest editor (no noteId): the menu item is absent", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    rightClickNode("a");
    // メニュー自体は開く（枝をテキストコピーはある）が、公開項目は無い
    await waitFor(() => menuItem("Copy branch as text"));
    expect(menuItem("Publish to web")).toBeNull();
  });
});
