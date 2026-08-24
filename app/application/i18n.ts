/**
 * Application layer: UI言語（ロケール）の状態と `t()`。
 *
 * editorPreferences と同じく「このデバイスでどう表示するか」の設定なので
 * localStorage に永続化する（ノートの内容ではない）。デフォルトは従来表示の
 * "ja" — 既存ユーザー・既存テストの見た目を変えないため、自動判定はしない。
 *
 * React に依存しない素のストアなので、キーマップやレデューサなどの
 * アプリケーション層からもそのまま `t()` を呼べる。コンポーネント側は
 * `useLocale()`（components/useLocale.ts）で購読して再レンダーする。
 */

import { defaultLocalStorage, type KeyValueStorage } from "./browserStorage";
import {
  MESSAGES_JA,
  MESSAGES_EN,
  type MessageKey,
} from "./messages";

export type Locale = "ja" | "en";

export const LOCALE_KEY = "edane:locale";

export const DEFAULT_LOCALE: Locale = "ja";

/** 表示名。言語名はそれ自身の言語で出す（翻訳しない）。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  ja: "日本語",
  en: "English",
};

/** editorPreferences と同じ網羅性イディオム（値検証用）。 */
const LOCALE_SET = {
  ja: true,
  en: true,
} as const satisfies Record<Locale, true>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in LOCALE_SET;
}

const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  ja: MESSAGES_JA,
  en: MESSAGES_EN,
};

/** Read the persisted locale (defaults on missing/invalid/SSR). */
export function loadLocale(
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): Locale {
  if (!storage) return DEFAULT_LOCALE;
  try {
    const raw = storage.getItem(LOCALE_KEY);
    return isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

let currentLocale: Locale = loadLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Switch the UI language: persists (best effort), keeps `<html lang>` truthful,
 * and notifies subscribers (React re-renders via useLocale).
 */
export function setLocale(
  locale: Locale,
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    storage?.setItem(LOCALE_KEY, locale);
  } catch {
    // localStorage unavailable (private mode, quota) — the in-memory locale
    // still applies for this session.
  }
  syncDocumentLang();
  for (const fn of listeners) fn();
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** SSRは lang="ja" 固定で出るので、クライアント側で実ロケールに合わせる。 */
export function syncDocumentLang(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = currentLocale;
  }
}

/** `toLocaleDateString` などに渡すBCP 47タグ。 */
export function dateLocale(): string {
  return currentLocale === "ja" ? "ja-JP" : "en-US";
}

/**
 * Look up a message in the current locale. `{name}` placeholders are replaced
 * from `params`. Missing params are left as-is (visible in dev, harmless).
 */
export function t(
  key: MessageKey,
  params?: Record<string, string | number>
): string {
  const msg = CATALOGS[currentLocale][key];
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m
  );
}
