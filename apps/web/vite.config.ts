import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { DevTools } from "@vitejs/devtools";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite-plus";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
  // Plugin order matters: tanstackRouter must run before plugin-react so the
  // generated routeTree is present when React transforms the route files.
  // Casts bridge vite-plus's bundled vite types with the plugins' vite 8 types.
  plugins: [
    tailwindcss() as unknown as PluginOption,
    tanstackRouter({ target: "react", autoCodeSplitting: true }) as unknown as PluginOption,
    react() as unknown as PluginOption,
    ...devtools,
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      // ws: true upgrades the proxy for /api/ws so the realtime WebSocket
      // (spec: specs/ws-realtime.md) reaches the API through the same origin
      // as the RPC calls — the client never learns the API port.
      "/api": { target: `http://localhost:${apiPort}`, ws: true },
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
