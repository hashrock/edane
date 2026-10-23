import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { BACKUP_INTERVAL_MS, isBackupDue } from "./noteBackups";

describe("isBackupDue", () => {
  it("is due for a note without backups, and always before a restore", () => {
    expect(isBackupDue(null, 0)).toBe(true);
    expect(isBackupDue(0, 1, "restore")).toBe(true);
  });

  it("is due exactly when the interval has passed (or the clock went back)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), fc.integer({ min: -(2 ** 32), max: 2 ** 32 }), (last, elapsed) => {
        expect(isBackupDue(last, last + elapsed)).toBe(elapsed < 0 || elapsed >= BACKUP_INTERVAL_MS);
      })
    );
  });
});
