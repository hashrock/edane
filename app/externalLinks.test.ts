/**
 * A user-supplied URL (a link node's text) is only ever opened or rendered as
 * an href through lib/url.ts's safeExternalUrl, which allows http(s) only.
 * This scans the UI for the raw forms so a new call site can't skip it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP = new URL(".", import.meta.url).pathname;
const RAW_LINK = /href=\{\s*node\.text\s*\}|window\.open\(\s*node\.text/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
  );
}

describe("external links", () => {
  it("never opens or links a node's raw text", () => {
    const offenders = ["components", "pages"]
      .flatMap((d) => sources(join(APP, d)))
      .filter((f) => RAW_LINK.test(readFileSync(f, "utf8")))
      .map((f) => relative(APP, f));
    expect(offenders).toEqual([]);
  });
});
