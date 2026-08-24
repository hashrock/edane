import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import ContextMenu from "./ContextMenu";
import { privateNoteCopyReason } from "../application/publicNoteLink";

/**
 * ノート一覧（app/pages/Notes/Index.tsx）の「リンクをコピー」は、非公開ノートでは
 * 項目を消さずに無効化して理由を見せる。その土台になる ContextMenu の disabled
 * 対応を、実ブラウザのクリックで確かめる。
 */

function picks(): string[] {
  const w = window as unknown as { __picks?: string[] };
  if (!w.__picks) w.__picks = [];
  return w.__picks;
}

function closes(): number[] {
  const w = window as unknown as { __closes?: number[] };
  if (!w.__closes) w.__closes = [];
  return w.__closes;
}

function renderMenu(disabled: boolean) {
  picks().length = 0;
  closes().length = 0;
  render(
    <ContextMenu
      x={20}
      y={20}
      onClose={() => closes().push(1)}
      items={[
        { label: "編集する", onSelect: () => picks().push("編集する") },
        {
          label: "リンクをコピー",
          disabled,
          disabledReason: privateNoteCopyReason(),
          onSelect: () => picks().push("リンクをコピー"),
        },
      ]}
    />
  );
}

async function waitFor<T>(fn: () => T | null | undefined | false): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const itemByLabel = (label: string) =>
  waitFor(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes(label)
    )
  );

describe("ContextMenu disabled items (browser e2e)", () => {
  it("runs onSelect and closes for an enabled item", async () => {
    renderMenu(false);
    await userEvent.click(await itemByLabel("リンクをコピー"));
    expect(picks()).toEqual(["リンクをコピー"]);
    expect(closes()).toEqual([1]);
  });

  it("keeps a disabled item visible and shows why it can't be used", async () => {
    renderMenu(true);
    const item = await itemByLabel("リンクをコピー");
    expect(item).toBeTruthy();
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain(privateNoteCopyReason());
  });

  it("does not run onSelect (nor close) when a disabled item is clicked", async () => {
    renderMenu(true);
    // userEvent は disabled 要素へのクリックを弾くので、素の click で
    // 「押されても何も起きない」ことを直接確かめる。
    (await itemByLabel("リンクをコピー")).click();
    expect(picks()).toEqual([]);
    expect(closes()).toEqual([]);
  });

  it("leaves other items in the same menu working", async () => {
    renderMenu(true);
    await userEvent.click(await itemByLabel("編集する"));
    expect(picks()).toEqual(["編集する"]);
    expect(closes()).toEqual([1]);
  });
});
