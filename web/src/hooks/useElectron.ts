/**
 * Detect if running inside Electron and provide click-through helpers.
 */

export function isElectron(): boolean {
  return (
    typeof window !== "undefined" &&
    (new URLSearchParams(window.location.search).get("electron") === "1" ||
      !!(window as any).electronAPI)
  );
}

/** Make the Electron window capture mouse events (interactive). */
export function enableClick() {
  (window as any).electronAPI?.setIgnoreMouseEvents(false);
}

/** Make the Electron window pass-through mouse events (transparent). */
export function disableClick() {
  (window as any).electronAPI?.setIgnoreMouseEvents(true, { forward: true });
}

/**
 * Set up global mousemove listener that toggles click-through
 * based on whether the cursor is over an element with [data-electron-interactive].
 * Call once at app startup.
 */
export function setupElectronClickThrough() {
  if (!isElectron()) return;

  document.addEventListener("mousemove", (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.closest("[data-electron-interactive]")) {
      enableClick();
    } else {
      disableClick();
    }
  });
}
