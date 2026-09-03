/**
 * Application layer: UI言語（ロケール）の状態と `t()`。
 *
 * editorPreferences と同じく「このデバイスでどう表示するか」の設定なので
 * localStorage に永続化する（ノートの内容ではない）。初期値はブラウザの言語
 * （navigator.language）から自動判定し（ja以外はすべて en）、ユーザーが設定で
 * 切り替えたらその選択（保存値）が常に優先される。
 *
 * React に依存しない素のストアなので、キーマップやレデューサなどの
 * アプリケーション層からもそのまま `t()` を呼べる。コンポーネント側は
 * `useLocale()`（components/useLocale.ts）で購読して再レンダーする。
 */

import { defaultLocalStorage, type KeyValueStorage } from "./browserStorage";
import { isKeyOf } from "../domain/isKeyOf";
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
  return isKeyOf(LOCALE_SET, value);
}

const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  ja: MESSAGES_JA,
  en: MESSAGES_EN,
};

/**
 * ブラウザ言語からの自動判定。対応言語は ja / en の2つなので、日本語系
 * （"ja" / "ja-JP" …）だけ ja、それ以外はすべて en に倒す。navigator が無い
 * 環境（SSR）は DEFAULT_LOCALE — サーバが出す `<html lang="ja">` と一致させる。
 */
export function detectLocale(
  language: string | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.language
): Locale {
  if (!language) return DEFAULT_LOCALE;
  return language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/**
 * Resolve the locale: an explicit persisted choice wins; otherwise fall back
 * to browser-language detection ({@link detectLocale}).
 */
export function loadLocale(
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): Locale {
  if (!storage) return detectLocale();
  try {
    const raw = storage.getItem(LOCALE_KEY);
    return isLocale(raw) ? raw : detectLocale();
  } catch {
    return detectLocale();
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
