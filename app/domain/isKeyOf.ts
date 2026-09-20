/**
 * Membership test for a closed string set declared as
 * `{ a: true, b: true } as const satisfies Record<T, true>`.
 *
 * `Object.hasOwn`, not `in`: the value is untrusted (JSON from the DB, the
 * clipboard, localStorage), and `"constructor" in {}` is true — `in` walks the
 * prototype chain, so a crafted `{"type":"constructor"}` would pass and then
 * blow up in an exhaustive switch. Every such set in the codebase must use
 * this, so the reason lives in exactly one place.
 */
export function isKeyOf<T extends string>(
  set: Readonly<Record<T, unknown>>,
  value: unknown
): value is T {
  return typeof value === "string" && Object.hasOwn(set, value);
}

/**
 * Builds the membership predicate AND the enumerable value list for a closed
 * string set declared as `{ a: true, b: true } as const satisfies Record<T,
 * true>`, from that same set — so a member added to `T` can't update one
 * without the other, which is the failure mode a hand-written pair (an
 * `isKeyOf` call plus a separate `Object.keys(...) as T[]`) leaves open. Used
 * for every closed set in the codebase that needs both a JSON-validating
 * predicate and a values list to enumerate in tests/generators (`NodeType`,
 * `EditorPreferences`'s three behaviors, `Locale`, …).
 */
export function closedStringSet<T extends string>(
  set: Readonly<Record<T, true>>
): { is: (value: unknown) => value is T; values: T[] } {
  return {
    is: (value: unknown): value is T => isKeyOf(set, value),
    values: Object.keys(set) as T[],
  };
}
