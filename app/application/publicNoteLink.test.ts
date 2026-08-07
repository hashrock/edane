import { describe, it, expect } from "vitest";
import {
  COPY_LINK_FAILURE,
  COPY_LINK_SUCCESS,
  PRIVATE_NOTE_COPY_REASON,
  publicNoteUrl,
} from "./publicNoteLink";

describe("publicNoteUrl", () => {
  it("builds the absolute viewing URL of a note", () => {
    expect(publicNoteUrl("https://edane.example", "abc123")).toBe(
      "https://edane.example/notes/abc123"
    );
  });

  it("keeps the port and scheme of the origin it is given", () => {
    expect(publicNoteUrl("http://localhost:5173", "n1")).toBe(
      "http://localhost:5173/notes/n1"
    );
  });

  // window.location.origin は末尾スラッシュを付けないが、設定値などを渡されても
  // `//notes/...` にならないようにしておく。
  it("does not double the slash when the origin has a trailing one", () => {
    expect(publicNoteUrl("https://edane.example/", "n1")).toBe(
      "https://edane.example/notes/n1"
    );
    expect(publicNoteUrl("https://edane.example///", "n1")).toBe(
      "https://edane.example/notes/n1"
    );
  });

  it("escapes ids so the path can't be broken out of", () => {
    expect(publicNoteUrl("https://edane.example", "a b/../c?x=1")).toBe(
      "https://edane.example/notes/a%20b%2F..%2Fc%3Fx%3D1"
    );
  });

  it("produces a URL the browser can parse back to the same path", () => {
    const url = new URL(publicNoteUrl("https://edane.example", "note-1"));
    expect(url.origin).toBe("https://edane.example");
    expect(url.pathname).toBe("/notes/note-1");
  });
});

describe("copy-link wording", () => {
  // UIの分岐（無効化の理由 / 成功 / 失敗）が同じ文字列にならないことだけ確認する。
  it("keeps the three user-facing strings distinct and non-empty", () => {
    const all = [PRIVATE_NOTE_COPY_REASON, COPY_LINK_SUCCESS, COPY_LINK_FAILURE];
    expect(all.every((s) => s.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(3);
  });
});
