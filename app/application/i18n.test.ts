import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALE_KEY,
  getLocale,
  isLocale,
  loadLocale,
  setLocale,
  subscribeLocale,
  dateLocale,
  t,
} from "./i18n";
import { MESSAGES_JA, MESSAGES_EN, type MessageKey } from "./messages";
import type { KeyValueStorage } from "./browserStorage";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

// モジュールレベルの現在言語を書き換えるので、各テスト後にデフォルトへ戻す。
afterEach(() => setLocale(DEFAULT_LOCALE, undefined));

describe("loadLocale", () => {
  it("defaults to ja without storage (SSR / node)", () => {
    expect(loadLocale(undefined)).toBe("ja");
  });

  it("reads a persisted locale and rejects unknown values", () => {
    expect(loadLocale(memoryStorage({ [LOCALE_KEY]: "en" }))).toBe("en");
    expect(loadLocale(memoryStorage({ [LOCALE_KEY]: "fr" }))).toBe(
      DEFAULT_LOCALE
    );
    expect(loadLocale(memoryStorage())).toBe(DEFAULT_LOCALE);
  });

  it("survives a throwing storage", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadLocale(broken)).toBe(DEFAULT_LOCALE);
  });
});

describe("setLocale / t", () => {
  it("switches the language t() resolves in and notifies subscribers", () => {
    let notified = 0;
    const unsub = subscribeLocale(() => notified++);
    expect(t("statusSaved")).toBe(MESSAGES_JA.statusSaved);

    setLocale("en", undefined);
    expect(getLocale()).toBe("en");
    expect(notified).toBe(1);
    expect(t("statusSaved")).toBe(MESSAGES_EN.statusSaved);
    expect(dateLocale()).toBe("en-US");

    // Same locale again = no-op (no extra notification).
    setLocale("en", undefined);
    expect(notified).toBe(1);
    unsub();
  });

  it("persists the choice into the given storage", () => {
    const storage = memoryStorage();
    setLocale("en", storage);
    expect(storage.getItem(LOCALE_KEY)).toBe("en");
  });

  it("interpolates {name} placeholders and leaves unknown ones visible", () => {
    setLocale("ja", undefined);
    expect(t("noNotesMatch", { query: "abc" })).toBe(
      "「abc」に一致するノートはありません。"
    );
    expect(t("mdLineCount", { n: 12 })).toBe("12行");
    setLocale("en", undefined);
    // 期待値はカタログから導く（enの文言そのものはカタログが正）。
    expect(t("mdLineCount", { n: 12 })).toBe(
      MESSAGES_EN.mdLineCount.replace("{n}", "12")
    );
    // 未指定のプレースホルダはそのまま残す（開発中に気づけるように）。
    expect(t("noNotesMatch")).toContain("{query}");
  });
});

describe("catalog integrity", () => {
  it("has a non-empty translation for every key in both locales", () => {
    // 文の組み立て上、片方の言語でだけ空になる断片キー（例: 日本語に文末
    // サフィックスは不要）。空が許されるのはここに並べたものだけ。
    const EMPTY_ALLOWED: ReadonlySet<MessageKey> = new Set([
      "alwaysEditHintSuffix",
    ]);
    for (const key of Object.keys(MESSAGES_JA) as MessageKey[]) {
      if (EMPTY_ALLOWED.has(key)) continue;
      expect(MESSAGES_JA[key].length, `ja:${key}`).toBeGreaterThan(0);
      expect(MESSAGES_EN[key].length, `en:${key}`).toBeGreaterThan(0);
    }
  });

  it("keeps the same {placeholders} in both languages", () => {
    const params = (s: string) =>
      new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    for (const key of Object.keys(MESSAGES_JA) as MessageKey[]) {
      expect(params(MESSAGES_EN[key]), key).toEqual(params(MESSAGES_JA[key]));
    }
  });

  it("keeps the English catalog actually English (no Japanese characters)", () => {
    for (const key of Object.keys(MESSAGES_EN) as MessageKey[]) {
      // 言語見出し（languageHeading）だけは両言語を併記する仕様。
      if (key === "languageHeading") continue;
      expect(MESSAGES_EN[key], `en:${key}`).not.toMatch(
        /[぀-ヿ㐀-䶿一-鿿]/
      );
    }
  });

  it("validates locale values", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});
