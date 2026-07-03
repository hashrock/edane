import { defineConfig } from "vitest/config";

// Standalone project for the round-2 characterization tests. Kept OUT of the
// main test config so CI's `pnpm test` is unaffected; run explicitly with:
//   npx vitest run --config formal/round2/repro/vitest.config.ts
export default defineConfig({
  test: {
    name: "formal-round2",
    include: ["formal/round2/repro/**/*.test.ts"],
    environment: "node",
  },
});
