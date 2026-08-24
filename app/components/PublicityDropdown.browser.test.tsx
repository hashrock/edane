import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import PublicityDropdown from "./PublicityDropdown";

function Harness({
  initial = false,
  copyLink = false,
}: {
  initial?: boolean;
  /** 「リンクをコピー」を出すかどうか（本番では noteId があるときだけ）。 */
  copyLink?: boolean;
}) {
  const [isPublic, setIsPublic] = useState(initial);
  return (
    <PublicityDropdown
      isPublic={isPublic}
      onChange={(next) => {
        calls().push(next);
        setIsPublic(next);
      }}
      onCopyLink={copyLink ? () => copyCalls().push(1) : undefined}
    />
  );
}

function calls(): boolean[] {
  const w = window as unknown as { __calls?: boolean[] };
  if (!w.__calls) w.__calls = [];
  return w.__calls;
}

function copyCalls(): number[] {
  const w = window as unknown as { __copyCalls?: number[] };
  if (!w.__copyCalls) w.__copyCalls = [];
  return w.__copyCalls;
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

const trigger = () =>
  waitFor(() => document.querySelector<HTMLButtonElement>("button"));
const popover = () => document.querySelector<HTMLElement>("[popover]");
const isOpen = () => !!popover()?.matches(":popover-open");
const menuItems = () =>
  Array.from(
    popover()?.querySelectorAll<HTMLButtonElement>("button") ?? []
  );

describe("PublicityDropdown (browser e2e)", () => {
  it("shows the current state on the trigger", async () => {
    calls().length = 0;
    render(<Harness initial={true} />);
    const label = (await trigger()).textContent ?? "";
    expect(label).toContain("Public");
    expect(label).not.toContain("Private");
  });

  it("shows Private when private", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    expect((await trigger()).textContent).toContain("Private");
  });

  it("renders the menu in the top layer (popover), not a z-indexed div", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    await trigger();
    // The menu is a real popover element — it lives in the browser top layer,
    // so it can't be occluded by the canvas/stacking contexts.
    expect(popover()).not.toBeNull();
    expect(popover()!.getAttribute("popover")).toBe("auto");
  });

  it("opens the menu, checks the active option, and switches on select", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);

    const items = menuItems();
    expect(items.map((b) => b.textContent?.replace("✓", "").trim())).toEqual([
      "Private",
      "Public",
    ]);
    // The active (private) option carries the check mark.
    expect(items[0].textContent).toContain("✓");
    expect(items[1].textContent).not.toContain("✓");

    await userEvent.click(items[1]);
    expect(calls()).toEqual([true]);
    // Menu closes after selecting.
    await waitFor(() => !isOpen());
    const label = (await trigger()).textContent ?? "";
    expect(label).toContain("Public");
    expect(label).not.toContain("Private");
  });

  it("renders above a high z-index overlay (the reported bug)", async () => {
    calls().length = 0;
    render(
      <>
        {/* Stand-in for the Konva canvas / stacking context that used to win. */}
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483647,
            background: "rgba(255,0,0,0.5)",
          }}
        />
        <Harness initial={false} />
      </>
    );
    // Open programmatically: in this synthetic layout the overlay also covers
    // the trigger (in the real app the trigger is in the header, above the
    // canvas). We only want to assert top-layer stacking of the open menu.
    await trigger();
    popover()!.showPopover();
    await waitFor(isOpen);

    // The top layer beats any z-index: the point over a menu item hits the
    // menu, not the overlay.
    const item = menuItems()[1];
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2
    );
    expect(popover()!.contains(hit)).toBe(true);
  });

  it("does not fire onChange when picking the already-active option", async () => {
    calls().length = 0;
    render(<Harness initial={true} />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);
    await userEvent.click(menuItems()[1]); // 公開 (already active)
    expect(calls()).toEqual([]);
  });
});

const copyItem = () =>
  popover()?.querySelector<HTMLButtonElement>('[data-testid="copy-link"]') ??
  null;

describe("PublicityDropdown リンクをコピー (browser e2e)", () => {
  it("is absent when no onCopyLink is given (unsaved / guest note)", async () => {
    calls().length = 0;
    copyCalls().length = 0;
    render(<Harness initial={true} />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);
    expect(copyItem()).toBeNull();
  });

  it("copies and closes the menu when the note is public", async () => {
    calls().length = 0;
    copyCalls().length = 0;
    render(<Harness initial={true} copyLink />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);

    const item = copyItem()!;
    expect(item.textContent).toContain("Copy link");
    expect(item.disabled).toBe(false);
    await userEvent.click(item);
    expect(copyCalls()).toEqual([1]);
    await waitFor(() => !isOpen());
  });

  // 非公開では「項目ごと消す」ではなく「無効化して理由を見せる」。理由まで出す
  // ことで、公開へ切り替えれば共有できると同じメニュー内で気づける。
  it("stays visible but disabled with a reason while the note is private", async () => {
    calls().length = 0;
    copyCalls().length = 0;
    render(<Harness initial={false} copyLink />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);

    const item = copyItem()!;
    expect(item).not.toBeNull();
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("Private notes can't be shared");

    // 押しても何も起きず、メニューも開いたまま。
    item.click();
    expect(copyCalls()).toEqual([]);
    expect(isOpen()).toBe(true);
  });

  it("becomes enabled as soon as the note is switched to public", async () => {
    calls().length = 0;
    copyCalls().length = 0;
    render(<Harness initial={false} copyLink />);
    await userEvent.click(await trigger());
    await waitFor(isOpen);
    expect(copyItem()!.disabled).toBe(true);

    await userEvent.click(menuItems()[1]); // 公開へ切り替え（メニューは閉じる）
    await waitFor(() => !isOpen());
    await userEvent.click(await trigger());
    await waitFor(isOpen);

    const item = await waitFor(() => {
      const el = copyItem();
      return el && !el.disabled ? el : null;
    });
    await userEvent.click(item);
    expect(copyCalls()).toEqual([1]);
  });
});
