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

import { defaultLocalStorage, type KeyValueStorage } from "./browserStorage";
import { isKeyOf } from "../domain/isKeyOf";

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
   * Enter in selection mode:
   * "insert-sibling" = add a sibling after the node (mindmap convention;
   *                    editing starts with Space / F2 / ⌘/Ctrl+Enter).
   * "edit"           = start editing the node — the two are simply swapped, so
   *                    ⌘/Ctrl+Enter takes over inserting the sibling. For
   *                    people who read Enter as "open this", where reaching
   *                    for Space feels wrong.
   */
  enterBehavior: "insert-sibling" | "edit";
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
  enterBehavior: "insert-sibling",
  arrowBehavior: "navigate",
};

export const PREFERENCES_KEY = "edane:editor-preferences";

/**
 * `satisfies Record<...>` makes this exhaustive both ways: adding a member to
 * `tabBehavior` refuses to compile here until it's declared, which is what
 * keeps {@link isTabBehavior} (used to validate localStorage JSON) from
 * silently dropping a newly-added value instead of erroring loudly at the
 * type level (same trick as `STORED_NODE_TYPE_SET` in domain/model.ts).
 */
const TAB_BEHAVIOR_SET = {
  indent: true,
  "insert-child": true,
} as const satisfies Record<EditorPreferences["tabBehavior"], true>;

function isTabBehavior(value: unknown): value is EditorPreferences["tabBehavior"] {
  return isKeyOf(TAB_BEHAVIOR_SET, value);
}

/**
 * Every `tabBehavior` member, derived from {@link TAB_BEHAVIOR_SET} so
 * callers that need to enumerate them (rather than just test membership via
 * {@link isTabBehavior}) stay in sync automatically when a member is added,
 * renamed, or removed (same trick as `NODE_TYPES` in domain/model.ts).
 */
export const TAB_BEHAVIORS = Object.keys(
  TAB_BEHAVIOR_SET
) as EditorPreferences["tabBehavior"][];

/** Same exhaustiveness trick as {@link TAB_BEHAVIOR_SET}, for `enterBehavior`. */
const ENTER_BEHAVIOR_SET = {
  "insert-sibling": true,
  edit: true,
} as const satisfies Record<EditorPreferences["enterBehavior"], true>;

function isEnterBehavior(
  value: unknown
): value is EditorPreferences["enterBehavior"] {
  return isKeyOf(ENTER_BEHAVIOR_SET, value);
}

/** Every `enterBehavior` member, derived like {@link TAB_BEHAVIORS}. */
export const ENTER_BEHAVIORS = Object.keys(
  ENTER_BEHAVIOR_SET
) as EditorPreferences["enterBehavior"][];

/** Same exhaustiveness trick as {@link TAB_BEHAVIOR_SET}, for `arrowBehavior`. */
const ARROW_BEHAVIOR_SET = {
  collapse: true,
  navigate: true,
} as const satisfies Record<EditorPreferences["arrowBehavior"], true>;

function isArrowBehavior(
  value: unknown
): value is EditorPreferences["arrowBehavior"] {
  return isKeyOf(ARROW_BEHAVIOR_SET, value);
}

/** Every `arrowBehavior` member, derived like {@link TAB_BEHAVIORS}. */
export const ARROW_BEHAVIORS = Object.keys(
  ARROW_BEHAVIOR_SET
) as EditorPreferences["arrowBehavior"][];

/**
 * Read preferences from storage. Unknown fields are dropped and invalid
 * or missing values fall back to the defaults, so a stale or hand-edited
 * entry can never wedge the editor. Safe without a DOM (SSR) — returns the
 * defaults.
 */
export function loadPreferences(
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): EditorPreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<EditorPreferences>;
    return {
      selectionMode:
        typeof parsed.selectionMode === "boolean"
          ? parsed.selectionMode
          : DEFAULT_PREFERENCES.selectionMode,
      tabBehavior: isTabBehavior(parsed.tabBehavior)
        ? parsed.tabBehavior
        : DEFAULT_PREFERENCES.tabBehavior,
      enterBehavior: isEnterBehavior(parsed.enterBehavior)
        ? parsed.enterBehavior
        : DEFAULT_PREFERENCES.enterBehavior,
      arrowBehavior: isArrowBehavior(parsed.arrowBehavior)
        ? parsed.arrowBehavior
        : DEFAULT_PREFERENCES.arrowBehavior,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Persist preferences. Best-effort: quota/privacy-mode failures are ignored. */
export function savePreferences(
  prefs: EditorPreferences,
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (private mode, quota) — the in-memory
    // preferences still apply for this session.
  }
}
