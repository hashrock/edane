/**
 * Application layer: per-device editor preferences.
 *
 * Persisted in localStorage (not on the note) because they describe how this
 * user drives the keyboard, not what the document contains. The settings form
 * a hierarchy: `selectionMode` is the parent toggle — when it is off the
 * editor never leaves edit mode, which makes the two selection-mode-only
 * settings (`tabBehavior`, `arrowBehavior`) inert; the settings UI greys them
 * out accordingly instead of pretending they still apply.
 */

export interface EditorPreferences {
  /**
   * true  = two-mode editing (selection + editing), the historical behaviour.
   * false = always-edit: every node interaction lands in edit mode, and the
   *         selection-only bindings are replaced by chorded alternatives
   *         (⌘/Ctrl+Shift+Backspace deletes a branch, ⌘/Ctrl+. folds).
   */
  selectionMode: boolean;
  /**
   * Tab in selection mode:
   * "indent"       = make the node a child of its previous sibling (outliner
   *                  convention; Shift+Tab outdents).
   * "insert-child" = insert a new child under the node (mindmap convention,
   *                  pairing with Enter = new sibling; Shift+Tab still
   *                  outdents).
   */
  tabBehavior: "indent" | "insert-child";
  /**
   * ←/→ in selection mode:
   * "collapse" = fold/unfold first, fall back to parent/child movement.
   * "navigate" = always move to parent/child (→ auto-expands a folded branch
   *              so focus never lands on a hidden node); folding is ⌘/Ctrl+.
   */
  arrowBehavior: "collapse" | "navigate";
}

export const DEFAULT_PREFERENCES: EditorPreferences = {
  selectionMode: true,
  tabBehavior: "insert-child",
  arrowBehavior: "navigate",
};

export const PREFERENCES_KEY = "edane:editor-preferences";

/**
 * Read preferences from localStorage. Unknown fields are dropped and invalid
 * or missing values fall back to the defaults, so a stale or hand-edited
 * entry can never wedge the editor. Safe without a DOM (SSR) — returns the
 * defaults.
 */
export function loadPreferences(): EditorPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<EditorPreferences>;
    return {
      selectionMode:
        typeof parsed.selectionMode === "boolean"
          ? parsed.selectionMode
          : DEFAULT_PREFERENCES.selectionMode,
      tabBehavior:
        parsed.tabBehavior === "indent" || parsed.tabBehavior === "insert-child"
          ? parsed.tabBehavior
          : DEFAULT_PREFERENCES.tabBehavior,
      arrowBehavior:
        parsed.arrowBehavior === "collapse" || parsed.arrowBehavior === "navigate"
          ? parsed.arrowBehavior
          : DEFAULT_PREFERENCES.arrowBehavior,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Persist preferences. Best-effort: quota/privacy-mode failures are ignored. */
export function savePreferences(prefs: EditorPreferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (private mode, quota) — the in-memory
    // preferences still apply for this session.
  }
}
