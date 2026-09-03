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
