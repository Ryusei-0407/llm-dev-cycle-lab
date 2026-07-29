import { DevTools } from "@vitejs/devtools";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite-plus";

// DEVTOOLS=1 のときだけ有効化: E2E・CI のスクリーンショットに
// フローティングパネルが混入しないようにする。
// キャストは vite-plus 同梱の vite 型とプラグイン側の vite 8 型の
// 二重定義衝突(TS2321)を回避するため
const devtools = process.env.DEVTOOLS
  ? [DevTools({ visibility: "passive" }) as unknown as PluginOption]
  : [];

// Ports are env-driven so parallel git worktrees can run E2E without
// colliding (WEB_PORT/API_PORT). Defaults match the historical fixed ports.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 8787);

export default defineConfig({
  plugins: [react() as unknown as PluginOption, ...devtools],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
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
