import { describe, it, expect, afterEach } from "vitest";
import { copyText } from "./clipboard";

/**
 * copyText の経路分岐を実ブラウザで確認する。実行環境の
 * `navigator.clipboard` は権限に左右されて不安定なので、経路の判定だけを見たい
 * ここでは毎回スタブに差し替える（差し替えは afterEach で必ず戻す）。
 */

type Restore = () => void;
const restores: Restore[] = [];

function stubClipboard(impl: { writeText?: (t: string) => Promise<void> } | undefined) {
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: impl,
    configurable: true,
  });
  restores.push(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    if (desc) Object.defineProperty(Navigator.prototype, "clipboard", desc);
  });
}

function stubExecCommand(impl: (cmd: string) => boolean) {
  const prev = document.execCommand;
  document.execCommand = impl as typeof document.execCommand;
  restores.push(() => {
    document.execCommand = prev;
  });
}

afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe("copyText (browser)", () => {
  it("uses the async clipboard API when it is available", async () => {
    const written: string[] = [];
    stubClipboard({
      writeText: async (t) => {
        written.push(t);
      },
    });
    // フォールバックが走っていないことを確かめるため、execCommand は失敗させる。
    stubExecCommand(() => false);

    expect(await copyText("https://edane.example/notes/n1")).toBe(true);
    expect(written).toEqual(["https://edane.example/notes/n1"]);
  });

  it("falls back to execCommand when navigator.clipboard is missing", async () => {
    // 非セキュアコンテキスト（http でのLAN共有など）の再現。
    stubClipboard(undefined);
    const cmds: string[] = [];
    stubExecCommand((cmd) => {
      cmds.push(cmd);
      return true;
    });

    expect(await copyText("hello")).toBe(true);
    expect(cmds).toEqual(["copy"]);
  });

  it("falls back to execCommand when writeText rejects (permission denied)", async () => {
    stubClipboard({
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    let seen: string | null = null;
    stubExecCommand(() => {
      seen = (document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
      return true;
    });

    expect(await copyText("fallback-payload")).toBe(true);
    // フォールバックは選択済みの textarea 経由でコピーする。
    expect(seen).toBe("fallback-payload");
  });

  it("reports false when neither path works", async () => {
    stubClipboard(undefined);
    stubExecCommand(() => false);
    expect(await copyText("nope")).toBe(false);
  });

  it("reports false instead of throwing when execCommand itself throws", async () => {
    stubClipboard(undefined);
    stubExecCommand(() => {
      throw new Error("boom");
    });
    expect(await copyText("nope")).toBe(false);
  });

  it("leaves no stray textarea behind and restores focus", async () => {
    // フォーカスを奪いっぱなしにすると、エディタの共有textareaから外れて
    // キーボード不変条件（CLAUDE.md）が崩れる。
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    stubClipboard(undefined);
    stubExecCommand(() => true);
    await copyText("x");

    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll("textarea").length).toBe(0);
    input.remove();
  });
});
