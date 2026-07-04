import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import PublicityDropdown from "./PublicityDropdown";

function Harness({ initial = false }: { initial?: boolean }) {
  const [isPublic, setIsPublic] = useState(initial);
  return (
    <PublicityDropdown
      isPublic={isPublic}
      onChange={(next) => {
        calls().push(next);
        setIsPublic(next);
      }}
    />
  );
}

function calls(): boolean[] {
  const w = window as unknown as { __calls?: boolean[] };
  if (!w.__calls) w.__calls = [];
  return w.__calls;
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
    expect(label).toContain("公開");
    expect(label).not.toContain("非公開");
  });

  it("shows 非公開 when private", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    expect((await trigger()).textContent).toContain("非公開");
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
      "非公開",
      "公開",
    ]);
    // The active (private) option carries the check mark.
    expect(items[0].textContent).toContain("✓");
    expect(items[1].textContent).not.toContain("✓");

    await userEvent.click(items[1]);
    expect(calls()).toEqual([true]);
    // Menu closes after selecting.
    await waitFor(() => !isOpen());
    const label = (await trigger()).textContent ?? "";
    expect(label).toContain("公開");
    expect(label).not.toContain("非公開");
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
