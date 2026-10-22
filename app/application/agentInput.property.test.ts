import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { codePointLength, tooLong, unknownField } from "./agentInput";

describe("agentInput", () => {
  it("rejects any key outside the allowed set, prototype names included", () => {
    const allowed = ["noteId", "nodeId", "text"];
    const extra = fc.oneof(
      fc.constantFrom("__proto__", "constructor", "toString", "hasOwnProperty"),
      fc.string().filter((k) => !allowed.includes(k))
    );
    fc.assert(
      fc.property(fc.subarray(allowed), extra, (keys, key) => {
        // JSON.parse keeps "__proto__" as an own key, as a request body would.
        const value = JSON.parse(JSON.stringify(Object.fromEntries([...keys.map((k) => [k, 1]), [key, 1]])));
        expect(unknownField(value, allowed)).toEqual({ code: "unknown-field", field: key });
        expect(unknownField(JSON.parse(JSON.stringify(Object.fromEntries(keys.map((k) => [k, 1])))), allowed)).toBeNull();
      })
    );
  });

  it("caps length in code points, matching JSON Schema maxLength", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "binary", minLength: 1, maxLength: 1 }), { maxLength: 40 }), fc.nat(40), (chars, limit) => {
        const s = chars.join("");
        expect(codePointLength(s)).toBe(chars.length);
        expect(tooLong("f", s, limit) !== null).toBe(chars.length > limit);
      })
    );
  });
});
