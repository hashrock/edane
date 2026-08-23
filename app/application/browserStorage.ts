/**
 * Application layer: minimal key-value storage abstraction.
 *
 * `editorPreferences.ts` and `guestNote.ts` persist to `localStorage`, but the
 * application layer must stay usable without a browser (see architecture.test.ts
 * — headless tests, SSR). Depending on the concrete global directly forces
 * every caller and every test to know about that detail; depending on this
 * narrow interface instead means only {@link defaultLocalStorage} — the one
 * place that actually needs a browser — touches the global.
 */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's localStorage, or undefined where none exists (SSR, node tests). */
export function defaultLocalStorage(): KeyValueStorage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
