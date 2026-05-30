import { defineConfig } from "vitest/config";

// Standalone Vitest config so tests run in a plain Node environment.
// The main vite.config.ts wires in @cloudflare/vite-plugin, which is
// incompatible with Vitest's environment setup; tests only exercise the
// framework-agnostic editor/domain logic, so no plugins are needed here.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
  },
});
