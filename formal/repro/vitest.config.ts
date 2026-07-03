import { defineConfig } from "vitest/config";

// Standalone project for the formal-findings reproductions. Kept OUT of the
// main test config so CI's `pnpm test` is unaffected; run explicitly with:
//   npx vitest run --config formal/repro/vitest.config.ts
export default defineConfig({
  test: {
    name: "formal-repro",
    include: ["formal/repro/**/*.test.ts"],
    environment: "node",
  },
});
