import { DevTools } from "@vitejs/devtools";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    react(),
    // DEVTOOLS=1 のときだけ有効化: E2E・CI のスクリーンショットに
    // フローティングパネルが混入しないようにする
    ...(process.env.DEVTOOLS ? [DevTools({ visibility: "passive" })] : []),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  test: {
    projects: [
      // Pure logic (parser, reducer) — fast, no browser.
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      // Component layer: real-browser behaviour JSDOM cannot reproduce
      // (incremental streaming render, scrolling, focus). Runs in the same
      // vp test invocation via the bundled Vitest browser mode.
      {
        extends: true,
        test: {
          name: "browser",
          include: ["test-browser/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
