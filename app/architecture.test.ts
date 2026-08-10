/**
 * Guards the layering described in CLAUDE.md / prior refactors: domain has no
 * internal deps, and each layer only reaches "inward" —
 *   domain <- lib <- application <- components <- pages
 * — never sideways into db/utils (server infrastructure) or "outward" into a
 * layer built on top of it. A violation here is a real regression (e.g. lib
 * reaching into application) even though nothing throws at runtime; nothing
 * else catches that shape of bug.
 *
 * The layering check only resolves relative specifiers, so it can't see a
 * bare `from "react"` — a separate check below guards domain/lib/application
 * against that blind spot specifically.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));

// Root-level files split into two kinds:
// - shared: plain type/declaration files with no framework or server
//   imports of their own, safe for any layer to depend on.
// - composition root (everything else at the app root, e.g. server.ts /
//   root-view.tsx / client.tsx): bootstraps the app and pulls in
//   Hono/react-dom/etc. No layer may reach into these, or a layer could
//   transitively import a UI framework through a re-export and the
//   UI-framework-specifier check below would never see it.
const ROOT_SHARED_FILES = new Set(["user.ts", "global.d.ts"]);

// Layer -> buckets it may import from (besides itself). Buckets not listed
// here (server.ts, root-view.tsx, client.tsx, user.ts, global.d.ts — the
// composition root) may import anything, so they're left out of this map.
const ALLOWED_IMPORTS: Record<string, string[]> = {
  domain: [],
  lib: ["domain"],
  application: ["domain", "lib"],
  components: ["domain", "lib", "application"],
  pages: ["domain", "lib", "application", "components"],
  db: [],
  utils: ["db"],
};

const LAYER_DIRS = new Set(Object.keys(ALLOWED_IMPORTS));

// domain/lib/application must stay usable without a UI framework (headless
// tests, the outline vs. canvas layouts sharing one keymap, ...). The
// relative-import check below can't see this: a bare `from "react"` never
// resolves to a path, so it silently bypasses the layering check entirely.
const NO_UI_FRAMEWORK_LAYERS = new Set(["domain", "lib", "application"]);
const UI_FRAMEWORK_SPECIFIERS = /^(react|react-dom)(\/|$)/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|bench)\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function bucketOf(file: string): string {
  const [first] = relative(APP_ROOT, file).split(/[\\/]/);
  return LAYER_DIRS.has(first) ? first : "root";
}

describe("dependency direction", () => {
  it("only imports across the domain -> lib -> application -> components -> pages layering", () => {
    const violations: string[] = [];

    for (const file of listSourceFiles(APP_ROOT)) {
      const fromBucket = bucketOf(file);
      const rule = ALLOWED_IMPORTS[fromBucket];
      if (!rule) continue; // composition-root files may import anything

      const content = readFileSync(file, "utf-8");
      const specs = [
        ...content.matchAll(/from\s+["'](\.[^"']+)["']/g),
        ...content.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
      ].map((m) => m[1]);

      for (const spec of specs) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        const toBucket = bucketOf(target);
        const isSharedRoot = toBucket === "root" && ROOT_SHARED_FILES.has(basename(target));
        if (toBucket === fromBucket || isSharedRoot || rule.includes(toBucket)) continue;
        violations.push(
          `${relative(APP_ROOT, file)} (${fromBucket}) imports ${relative(APP_ROOT, target)} (${toBucket}); ` +
            `${fromBucket} may only import [${rule.join(", ") || "nothing"}]`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps domain/lib/application free of UI-framework imports", () => {
    const violations: string[] = [];

    for (const file of listSourceFiles(APP_ROOT)) {
      const fromBucket = bucketOf(file);
      if (!NO_UI_FRAMEWORK_LAYERS.has(fromBucket)) continue;

      const content = readFileSync(file, "utf-8");
      const specs = [
        ...content.matchAll(/from\s+["']([^"']+)["']/g),
        ...content.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]);

      for (const spec of specs) {
        if (spec.startsWith(".")) continue; // resolved & checked above
        if (!UI_FRAMEWORK_SPECIFIERS.test(spec)) continue;
        violations.push(
          `${relative(APP_ROOT, file)} (${fromBucket}) imports "${spec}"; ` +
            `${fromBucket} must stay usable without a UI framework`
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
