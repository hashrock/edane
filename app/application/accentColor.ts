/**
 * Application layer: per-device accent colour.
 *
 * The UI's accent is the Tailwind `emerald-*` ramp; styles.css redefines that
 * ramp from the single `--accent` custom property, so changing the colour is
 * one `setProperty` and every utility class follows. The canvas draws with
 * Konva (no CSS), so it reads {@link getAccent} / {@link withAlpha} instead.
 * Same store shape as i18n.ts (module value + subscribe + best-effort
 * localStorage), kept apart from editorPreferences because it has nothing to
 * do with the keyboard.
 */

import { defaultLocalStorage, type KeyValueStorage } from "./browserStorage";

export const ACCENT_KEY = "edane:accent-color";
/** emerald-500 — the colour the UI had before this was configurable. */
export const DEFAULT_ACCENT = "#10b981";

/** `#rrggbb`, lowercase — the only form `<input type="color">` produces. */
export function isAccentColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
}

/** `#rrggbb` + alpha (0..1) → `#rrggbbaa`, for Konva fills that need a tint. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return hex + a.toString(16).padStart(2, "0");
}

export function loadAccent(
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): string {
  try {
    const raw = storage?.getItem(ACCENT_KEY);
    return isAccentColor(raw) ? raw : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let currentAccent = loadAccent();
const listeners = new Set<() => void>();

export function getAccent(): string {
  return currentAccent;
}

/** Switch the accent: persists (best effort), repaints the DOM, notifies React. */
export function setAccent(
  color: string,
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): void {
  if (!isAccentColor(color) || color === currentAccent) return;
  currentAccent = color;
  try {
    storage?.setItem(ACCENT_KEY, color);
  } catch {
    // localStorage unavailable — the in-memory accent still applies.
  }
  syncDocumentAccent();
  for (const fn of listeners) fn();
}

export function subscribeAccent(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** SSR renders the default; the client calls this at boot to match storage. */
export function syncDocumentAccent(): void {
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--accent", currentAccent);
  }
}
