import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import {
  parseField,
  parseNumeric,
  inferValueKind,
  formatFieldValue,
  objectSiblingTemplate,
} from "./objectField";

describe("parseField", () => {
  it("splits at the first ASCII colon", () => {
    expect(parseField("価格: 1200")).toEqual({ key: "価格", value: "1200" });
  });

  it("splits at a full-width colon", () => {
    expect(parseField("名前：太郎")).toEqual({ key: "名前", value: "太郎" });
  });

  it("keeps colons after the first inside the value", () => {
    expect(parseField("時刻: 12:30")).toEqual({ key: "時刻", value: "12:30" });
  });

  it("treats a bare URL as a keyless value (https is not a key)", () => {
    expect(parseField("https://example.com")).toEqual({
      key: null,
      value: "https://example.com",
    });
  });

  it("allows a URL as a keyed value", () => {
    expect(parseField("site: https://example.com")).toEqual({
      key: "site",
      value: "https://example.com",
    });
  });

  it("returns keyless for text without a colon", () => {
    expect(parseField("ただのメモ")).toEqual({ key: null, value: "ただのメモ" });
  });

  it("returns keyless for empty text and for an empty key", () => {
    expect(parseField("")).toEqual({ key: null, value: "" });
    expect(parseField(": value")).toEqual({ key: null, value: ": value" });
  });

  it("keeps an empty value for a trailing-colon key (prefilled row)", () => {
    expect(parseField("価格: ")).toEqual({ key: "価格", value: "" });
  });

  it("rejects a key containing a slash", () => {
    expect(parseField("a/b: c")).toEqual({ key: null, value: "a/b: c" });
  });
});

describe("parseNumeric / inferValueKind", () => {
  it("parses plain and comma-grouped numbers", () => {
    expect(parseNumeric("1200")).toBe(1200);
    expect(parseNumeric("1,234.5")).toBe(1234.5);
    expect(parseNumeric("-0.5")).toBe(-0.5);
    expect(parseNumeric(".5")).toBe(0.5);
  });

  it("rejects non-numbers", () => {
    expect(parseNumeric("12px")).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("1.2.3")).toBeNull();
  });

  it("infers kinds", () => {
    expect(inferValueKind("")).toBe("empty");
    expect(inferValueKind("1,200")).toBe("number");
    expect(inferValueKind("https://example.com")).toBe("url");
    expect(inferValueKind("https://example.com/a.png")).toBe("image");
    expect(inferValueKind("https://example.com/a.png?w=100")).toBe("image");
    expect(inferValueKind("2026-07-10")).toBe("date");
    expect(inferValueKind("2026/7/1")).toBe("date");
    expect(inferValueKind("hello")).toBe("text");
  });
});

describe("formatFieldValue", () => {
  it("passes non-numeric values through unchanged", () => {
    expect(formatFieldValue("hello", "comma")).toBe("hello");
  });

  it("returns the raw value when no format is set", () => {
    expect(formatFieldValue("1234.5")).toBe("1234.5");
  });

  it("groups thousands", () => {
    expect(formatFieldValue("1234567", "comma")).toBe("1,234,567");
    expect(formatFieldValue("1,234", "comma")).toBe("1,234");
  });

  it("formats currency with grouping and sign", () => {
    expect(formatFieldValue("1234", "currency")).toBe("¥1,234");
    expect(formatFieldValue("-1234", "currency")).toBe("-¥1,234");
  });

  it("formats percent literally (50 → 50%, not 5000%)", () => {
    expect(formatFieldValue("50", "percent")).toBe("50%");
  });

  it("applies fixed decimals, alone or with a format", () => {
    expect(formatFieldValue("1234.567", undefined, 2)).toBe("1234.57");
    expect(formatFieldValue("1234.5", "comma", 2)).toBe("1,234.50");
    expect(formatFieldValue("3", "percent", 1)).toBe("3.0%");
  });
});

describe("objectSiblingTemplate", () => {
  const card: MindMapModel = {
    id: "card",
    text: "商品A",
    type: "object",
    children: [
      { id: "r1", text: "価格: 1200", children: [], numFormat: "currency" },
      { id: "r2", text: "率: 3.5", children: [], decimals: 1 },
      { id: "r3", text: "キーなしメモ", children: [] },
      { id: "r4", text: "https://x.test/a.png", type: "image", children: [] },
    ],
  };

  it("prefills keys with empty values and carries display formats", () => {
    const t = objectSiblingTemplate(card);
    expect(t.type).toBe("object");
    expect(t.text).toBe("");
    expect(t.children.map((c) => c.text)).toEqual(["価格: ", "率: "]);
    expect(t.children[0].numFormat).toBe("currency");
    expect(t.children[1].decimals).toBe(1);
  });

  it("assigns fresh ids", () => {
    const t = objectSiblingTemplate(card);
    expect(t.id).not.toBe(card.id);
    expect(t.children[0].id).not.toBe("r1");
  });

  it("returns an empty card for a card with no keyed rows", () => {
    const t = objectSiblingTemplate({
      id: "c",
      text: "x",
      type: "object",
      children: [{ id: "n", text: "メモだけ", children: [] }],
    });
    expect(t.children).toEqual([]);
  });
});
