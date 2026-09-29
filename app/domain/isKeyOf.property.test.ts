/**
 * Property-based tests for the closed-string-set helpers: membership is exact
 * (own keys only — never prototype-chain names), for any untrusted value.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { closedStringSet, isKeyOf } from "./isKeyOf";

const setArb = fc
  .uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 })
  .map((keys) => Object.fromEntries(keys.map((k) => [k, true as const])));

const PROTOTYPE_NAMES = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"];

describe("isKeyOf", () => {
  it("accepts exactly the own keys of the set", () => {
    fc.assert(
      fc.property(setArb, fc.string(), (set, s) => {
        expect(isKeyOf(set, s)).toBe(Object.keys(set).includes(s));
      })
    );
  });

  it("rejects every non-string value", () => {
    fc.assert(
      fc.property(setArb, fc.anything().filter((v) => typeof v !== "string"), (set, v) => {
        expect(isKeyOf(set, v)).toBe(false);
      })
    );
  });

  it("rejects prototype-chain names unless they are own keys", () => {
    fc.assert(
      fc.property(setArb, fc.constantFrom(...PROTOTYPE_NAMES), (set, name) => {
        expect(isKeyOf(set, name)).toBe(Object.hasOwn(set, name));
      })
    );
  });
});

describe("closedStringSet", () => {
  it("lists every member, and the predicate agrees with the list", () => {
    fc.assert(
      fc.property(setArb, fc.string(), (set, s) => {
        const { is, values } = closedStringSet(set);
        expect([...values].sort()).toEqual(Object.keys(set).sort());
        expect(values.every(is)).toBe(true);
        expect(is(s)).toBe(values.includes(s));
      })
    );
  });
});
