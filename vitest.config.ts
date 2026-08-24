import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Two test projects:
//  - "node":    framework-agnostic editor/domain logic in plain Node.
//  - "browser": real-browser e2e for the React editor (focus/typing), run via
//               Playwright (chromium). The main vite.config.ts wires in
//               @cloudflare/vite-plugin which is incompatible with Vitest, so we
//               only pull in the React plugin here.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["app/**/*.test.ts"],
          benchmark: { include: ["app/**/*.bench.ts"] },
          environment: "node",
          // UI言語を en に固定（実行マシンの言語で文言の期待値が揺れないように）
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "browser",
          include: ["app/**/*.browser.test.tsx"],
          // UI言語を en に固定（実行マシンの言語で文言の期待値が揺れないように）
          setupFiles: ["./vitest.setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
