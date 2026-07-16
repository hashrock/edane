import { describe, expect, it } from "vitest";
import { resolveDevGuestPreference } from "./devAuthBypass";

describe("resolveDevGuestPreference", () => {
  it("defaults to non-guest when there is no cookie and no query param", () => {
    expect(resolveDevGuestPreference("", null)).toEqual({ guest: false });
  });

  it("reads guest state from the dev_guest cookie", () => {
    expect(resolveDevGuestPreference("dev_guest=1", null)).toEqual({
      guest: true,
    });
  });

  it("ignores unrelated cookies", () => {
    expect(resolveDevGuestPreference("session=abc; other=1", null)).toEqual({
      guest: false,
    });
  });

  it("matches dev_guest=1 among multiple cookies", () => {
    expect(
      resolveDevGuestPreference("session=abc; dev_guest=1; other=1", null)
    ).toEqual({ guest: true });
  });

  it("?guest=1 flips into guest mode and sets the cookie", () => {
    expect(resolveDevGuestPreference("", "1")).toEqual({
      guest: true,
      setCookieHeader: "dev_guest=1; Path=/; SameSite=Lax",
    });
  });

  it("?guest=0 flips back to Dev User and clears the cookie", () => {
    expect(resolveDevGuestPreference("dev_guest=1", "0")).toEqual({
      guest: false,
      setCookieHeader: "dev_guest=; Path=/; Max-Age=0; SameSite=Lax",
    });
  });

  it("any non-'0' query value is treated as guest=true", () => {
    expect(resolveDevGuestPreference("", "yes")).toEqual({
      guest: true,
      setCookieHeader: "dev_guest=1; Path=/; SameSite=Lax",
    });
  });

  it("query param overrides an existing cookie", () => {
    expect(resolveDevGuestPreference("dev_guest=1", "0")).toEqual({
      guest: false,
      setCookieHeader: "dev_guest=; Path=/; Max-Age=0; SameSite=Lax",
    });
  });
});
