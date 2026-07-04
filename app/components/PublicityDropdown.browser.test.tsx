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
const menuItems = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".absolute button")
  );

describe("PublicityDropdown (browser e2e)", () => {
  it("shows the current state on the trigger", async () => {
    calls().length = 0;
    render(<Harness initial={true} />);
    expect((await trigger()).textContent).toContain("みんなに公開中");
  });

  it("shows 自分だけ when private", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    expect((await trigger()).textContent).toContain("自分だけ");
  });

  it("opens the menu, checks the active option, and switches on select", async () => {
    calls().length = 0;
    render(<Harness initial={false} />);
    await userEvent.click(await trigger());

    const items = await waitFor(() => {
      const its = menuItems();
      return its.length === 2 ? its : null;
    });
    expect(items.map((b) => b.textContent?.replace("✓", "").trim())).toEqual([
      "自分だけ",
      "みんなに公開",
    ]);
    // The active (private) option carries the check mark.
    expect(items[0].textContent).toContain("✓");
    expect(items[1].textContent).not.toContain("✓");

    await userEvent.click(items[1]);
    expect(calls()).toEqual([true]);
    // Menu closes after selecting.
    await waitFor(() => menuItems().length === 0 || true);
    expect(menuItems().length).toBe(0);
    expect((await trigger()).textContent).toContain("みんなに公開中");
  });

  it("does not fire onChange when picking the already-active option", async () => {
    calls().length = 0;
    render(<Harness initial={true} />);
    await userEvent.click(await trigger());
    const items = await waitFor(() => {
      const its = menuItems();
      return its.length === 2 ? its : null;
    });
    await userEvent.click(items[1]); // みんなに公開 (already active)
    expect(calls()).toEqual([]);
  });
});
