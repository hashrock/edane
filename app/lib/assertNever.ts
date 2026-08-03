/**
 * Put in a switch's `default` branch over a discriminated union to turn
 * "forgot to handle a new variant" into a compile error at this exact call
 * site, instead of a silent fallthrough at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
