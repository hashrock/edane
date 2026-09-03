import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_LOCALE,
  detectLocale,
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
import { memoryStorage, type KeyValueStorage } from "./browserStorage";

// モジュールレベルの現在言語を書き換えるので、各テスト後にテスト既定の en
// （vitest.setup.ts が固定する）へ戻す。
afterEach(() => setLocale("en", undefined));

describe("detectLocale", () => {
  it("maps Japanese browser languages to ja and everything else to en", () => {
    expect(detectLocale("ja")).toBe("ja");
    expect(detectLocale("ja-JP")).toBe("ja");
    expect(detectLocale("JA-JP")).toBe("ja");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("de-DE")).toBe("en");
    expect(detectLocale("zh-CN")).toBe("en");
  });

  it("falls back to the SSR default when no language is available", () => {
    // undefined を明示的に渡すとデフォルト引数（navigator.language）が効いて
    // しまうJSの仕様があるので、「言語なし」は空文字で表す。
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
  });
});

describe("loadLocale", () => {
  it("prefers a persisted choice over detection", () => {
    expect(loadLocale(memoryStorage({ [LOCALE_KEY]: "en" }))).toBe("en");
    expect(loadLocale(memoryStorage({ [LOCALE_KEY]: "ja" }))).toBe("ja");
  });

  it("falls back to detection for missing or unknown values", () => {
    expect(loadLocale(memoryStorage({ [LOCALE_KEY]: "fr" }))).toBe(
      detectLocale()
    );
    expect(loadLocale(memoryStorage())).toBe(detectLocale());
    expect(loadLocale(undefined)).toBe(detectLocale());
  });

  it("survives a throwing storage", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadLocale(broken)).toBe(detectLocale());
  });
});

describe("setLocale / t", () => {
  it("switches the language t() resolves in and notifies subscribers", () => {
    let notified = 0;
    const unsub = subscribeLocale(() => notified++);
    expect(t("statusSaved")).toBe(MESSAGES_EN.statusSaved);
    expect(dateLocale()).toBe("en-US");

    setLocale("ja", undefined);
    expect(getLocale()).toBe("ja");
    expect(notified).toBe(1);
    expect(t("statusSaved")).toBe(MESSAGES_JA.statusSaved);
    expect(dateLocale()).toBe("ja-JP");

    // Same locale again = no-op (no extra notification).
    setLocale("ja", undefined);
    expect(notified).toBe(1);
    unsub();
  });

  it("persists the choice into the given storage", () => {
    const storage = memoryStorage();
    setLocale("ja", storage);
    expect(storage.getItem(LOCALE_KEY)).toBe("ja");
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

describe("isLocale against prototype names", () => {
  // `"toString" in LOCALE_SET` is true via Object.prototype; membership must
  // be own-property only (same idiom fixed in editorPreferences / model).
  it("rejects inherited property names", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(isLocale(name)).toBe(false);
    }
  });
});
