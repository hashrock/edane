/**
 * t() の補間と、ロケール判定・永続化の総当たり。固定文言の例示テストは
 * i18n.test.ts にあるので、ここは「どのキー × どんな値でも成り立つこと」だけを持つ。
 */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import {
  LOCALES,
  detectLocale,
  loadLocale,
  setLocale,
  t,
} from "./i18n";
import { MESSAGES_JA, MESSAGES_EN, type MessageKey } from "./messages";
import { memoryStorage } from "./browserStorage";

afterEach(() => setLocale("en", undefined));

const localeArb = fc.constantFrom(...LOCALES);
const catalogs = { ja: MESSAGES_JA, en: MESSAGES_EN } as const;
const keyArb = fc.constantFrom(...(Object.keys(MESSAGES_EN) as MessageKey[]));
// `$&` や `{name}` を含めて、置換が1パスで値を再解釈しないことも突く。
const valueArb = fc.oneof(
  fc.string(),
  fc.constantFrom("$&", "$1", "{n}", "{count}", "}{"),
  fc.integer()
);

describe("t", () => {
  it("returns the catalog string unchanged when no params are given", () => {
    fc.assert(
      fc.property(localeArb, keyArb, (locale, key) => {
        setLocale(locale, undefined);
        expect(t(key)).toBe(catalogs[locale][key]);
      })
    );
  });

  it("substitutes every placeholder in a single pass, never re-reading the values", () => {
    fc.assert(
      fc.property(localeArb, keyArb, valueArb, (locale, key, value) => {
        setLocale(locale, undefined);
        const msg = catalogs[locale][key];
        const params = Object.fromEntries(
          [...msg.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], value])
        );
        const expected = msg.split(/\{\w+\}/).join(String(value));
        expect(t(key, params)).toBe(expected);
      })
    );
  });

  it("ignores params that name no placeholder", () => {
    fc.assert(
      fc.property(localeArb, keyArb, valueArb, (locale, key, value) => {
        setLocale(locale, undefined);
        expect(t(key, { __unused__: value })).toBe(catalogs[locale][key]);
      })
    );
  });
});

describe("detectLocale", () => {
  it("is ja exactly for languages starting with ja (any case), en otherwise", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (language) => {
        const isJa = language.toLowerCase().startsWith("ja");
        expect(detectLocale(language)).toBe(isJa ? "ja" : "en");
      })
    );
  });
});

describe("setLocale / loadLocale", () => {
  // 現在値と同じ言語を選んだ場合 setLocale は何も保存しない（早期 return）ので、
  // 往復が成り立つのは「切り替えた」ときだけ。
  it("round-trips any locale switched to through storage", () => {
    fc.assert(
      fc.property(localeArb, localeArb, (start, chosen) => {
        fc.pre(start !== chosen);
        setLocale(start, undefined);
        const storage = memoryStorage();
        setLocale(chosen, storage);
        setLocale(start, undefined);
        expect(loadLocale(storage)).toBe(chosen);
      })
    );
  });
});
