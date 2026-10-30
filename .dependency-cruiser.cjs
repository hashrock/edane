/**
 * dependency-cruiser: checks that complement app/architecture.test.ts.
 *
 * The per-layer import table stays in architecture.test.ts (one source of
 * truth). This file covers what a one-hop, regex-based check cannot see:
 * - transitive reach: a pure layer pulling a framework in through another
 *   module (e.g. domain -> global.d.ts -> auth/routePolicy.ts -> hono), which
 *   the "shared root file" exemption there lets through;
 * - runtime import cycles;
 * - production modules no entry point reaches any more (dead code kept alive
 *   only by its own tests);
 * - production code importing test support, and imports of packages that are
 *   not declared in package.json.
 *
 * Run: pnpm lint:deps
 */

// Files that exist only for tests/benchmarks. They may import anything
// (vitest, fast-check, fakes) and production code must never import them.
const TEST_SUPPORT =
  "(\\.(test|bench)\\.tsx?|\\.arb\\.ts|\\.testHelpers\\.ts|/fakeSyncSocket\\.ts)$";

// Everything that loads app code without being imported by it: the Worker
// (wrangler.jsonc main), the <Script> tags in root-view / webpage-view, the
// Inertia page glob in client.tsx, and the `new Worker(new URL(...))` in
// lib/shoreRunner.ts.
const ENTRY_POINTS = [
  "^app/server\\.ts$",
  "^app/client\\.tsx$",
  "^app/webpage-runtime\\.ts$",
  "^app/lib/shore\\.worker\\.ts$",
  "^app/pages/.+\\.tsx$",
];

module.exports = {
  forbidden: [
    {
      name: "pure-layers-no-framework",
      comment:
        "domain / lib / application must stay usable without a UI or server framework, " +
        "including through other modules (architecture.test.ts only sees direct imports, " +
        "and exempts the shared root files).",
      severity: "error",
      from: { path: "^app/(domain|lib|application)/", pathNot: TEST_SUPPORT },
      to: {
        reachable: true,
        path: "node_modules/(react|react-dom|hono|@hono|drizzle-orm|@inertiajs)/",
      },
    },
    {
      name: "no-circular",
      comment:
        "Runtime import cycle. Type-only edges are ignored: global.d.ts declares the Hono " +
        "context from auth/ and sync/ types, and those modules import Env back from it.",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "no-unreachable-from-entry",
      comment:
        "No production entry point reaches this module: it is dead code (possibly kept " +
        "alive by its own tests). Delete it, or wire it up.",
      severity: "error",
      from: { path: ENTRY_POINTS },
      to: {
        path: "^app/",
        pathNot: [TEST_SUPPORT, "\\.d\\.ts$", "\\.css$", ...ENTRY_POINTS],
        reachable: false,
      },
    },
    {
      name: "not-to-test-support",
      comment: "Production code must not depend on test files, generators or fakes.",
      severity: "error",
      from: { path: "^app/", pathNot: TEST_SUPPORT },
      to: { path: TEST_SUPPORT },
    },
    {
      name: "no-non-package-json",
      comment:
        "Imports a package that is not declared in package.json (works only because pnpm " +
        "hoisted it, or a transitive dependency happens to provide it).",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    // `import type` edges are real dependencies for layering purposes.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    // Provided by the Workers runtime, not by a package.
    builtInModules: { add: ["cloudflare:workers"] },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    skipAnalysisNotInRules: true,
  },
};
