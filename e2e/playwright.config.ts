import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(configDir, "..");

// Ports are env-driven (WEB_PORT/API_PORT) so parallel git worktrees can run
// E2E without colliding. Defaults match the historical fixed ports; the web
// dev server proxies /api to API_PORT (apps/web/vite.config.ts reads the same).
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 8787);
const webBaseURL = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(configDir, "test-results"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  maxFailures: process.env.CI ? 5 : 0,
  reporter: process.env.CI
    ? [
        ["html", { outputFolder: path.join(configDir, "playwright-report"), open: "never" }],
        ["json", { outputFile: path.join(configDir, "results.json") }],
        ["github"],
        ["list"],
      ]
    : [
        ["html", { outputFolder: path.join(configDir, "playwright-report"), open: "never" }],
        ["list"],
      ],
  use: {
    baseURL: webBaseURL,
    // PW_TRACE=on is the nightly perf lane: record everything so the
    // trace-analyst can mine timings. Default stays cheap for the PR lane.
    trace: process.env.PW_TRACE === "on" ? "on" : "on-first-retry",
    // CI records video for every test: the suite is small and the PR media
    // comment (scripts/pr-media-comment.mjs) attaches evidence for passing
    // runs too. Revisit if the suite grows enough to hurt the time budget.
    // Screenshots are staged explicitly via helpers/snap.ts (initial state +
    // one per UI state change); the automatic one only fires on failure.
    // Explicit size: Playwright otherwise scales recordings down to fit
    // 800x800, which caps the gif resolution at 800px wide.
    video: process.env.CI
      ? { mode: "on", size: { width: 1280, height: 720 } }
      : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Auth setup: logs the seed roles in once and writes storageState to
    // e2e/.auth/<role>.json, so feature projects start already authenticated.
    // The auth guard now protects "/", so every feature test (chat included)
    // needs a session; the guard itself is exercised unauthenticated by
    // auth.spec.ts, which overrides storageState per-describe.
    { name: "setup", testDir: path.join(configDir, "setup"), testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Default every chromium test to the seeded agent session. auth.spec.ts
        // opts back out to an empty state to test the guard/login flow.
        storageState: path.join(configDir, ".auth", "agent.json"),
      },
      dependencies: ["setup"],
    },
    // Playwright component tests (stories & galleries): reserved for cases
    // Vitest Browser Mode cannot cover — page.clock, page.route, video/trace
    // evidence at component level. See docs/POLICY.md for the layer rules.
    {
      name: "components",
      testDir: path.join(configDir, "components"),
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `${webBaseURL}/playwright/gallery/index.html`,
        serviceWorkers: "block",
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @app/api dev",
      cwd: root,
      port: apiPort,
      reuseExistingServer: !process.env.CI,
      env: {
        ...(process.env as Record<string, string>),
        API_PORT: String(apiPort),
        MOCK_DELAY_MS: "20",
        // Force the provider for the test lane: real Gemini only under the
        // explicit LLM_SMOKE=1 nightly opt-in, mock otherwise. This overrides
        // any LLM_PROVIDER=gemini that leaked in from a local .env, so ordinary
        // E2E always runs against the deterministic mock.
        LLM_PROVIDER: process.env.LLM_SMOKE === "1" ? "gemini" : "mock",
      },
    },
    {
      command: "pnpm --filter @app/web dev",
      cwd: root,
      port: webPort,
      reuseExistingServer: !process.env.CI,
      env: {
        ...(process.env as Record<string, string>),
        WEB_PORT: String(webPort),
        API_PORT: String(apiPort),
      },
    },
  ],
});
