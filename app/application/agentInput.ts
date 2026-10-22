/**
 * Application layer: the strictness rules for input an agent sends to edit a
 * note — the remote MCP tools (app/mcp/) and the in-page WebMCP tool. Each
 * boundary keeps its own parser and wording; what they share is how strict
 * they are: unknown fields are rejected (never silently ignored) and strings
 * have a length cap. Pure: returns an {@link InputIssue}, never throws.
 */

/** Length caps, in Unicode code points (what JSON Schema `maxLength` counts). */
export const AGENT_INPUT_LIMITS = {
  /** Note title. */
  title: 200,
  /** One node's text. */
  text: 100_000,
  /** A Markdown snippet that becomes nodes. */
  markdown: 500_000,
  /** Note / node id. */
  id: 200,
  /** Search query. */
  query: 200,
  /** An agent-chosen operation id (the receipt key; NoteRoom's wire format allows 100). */
  operationId: 100,
} as const;

export type InputIssue =
  | { code: "unknown-field"; field: string }
  | { code: "too-long"; field: string; limit: number };

/** Code points, not UTF-16 units — a surrogate pair is one character, as in JSON Schema. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The first own key of `value` that isn't allowed (`__proto__` included). */
export function unknownField(
  value: Record<string, unknown>,
  allowed: readonly string[]
): InputIssue | null {
  const field = Object.keys(value).find((k) => !allowed.includes(k));
  return field === undefined ? null : { code: "unknown-field", field };
}

export function tooLong(field: string, value: string, limit: number): InputIssue | null {
  return codePointLength(value) > limit ? { code: "too-long", field, limit } : null;
}
