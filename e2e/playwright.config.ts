import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(configDir, '..');

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(configDir, 'test-results'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  maxFailures: process.env.CI ? 5 : 0,
  reporter: process.env.CI
    ? [
        ['html', { outputFolder: path.join(configDir, 'playwright-report'), open: 'never' }],
        ['json', { outputFile: path.join(configDir, 'results.json') }],
        ['github'],
        ['list'],
      ]
    : [
        ['html', { outputFolder: path.join(configDir, 'playwright-report'), open: 'never' }],
        ['list'],
      ],
  use: {
    baseURL: 'http://localhost:5173',
    // PW_TRACE=on is the nightly perf lane: record everything so the
    // trace-analyst can mine timings. Default stays cheap for the PR lane.
    trace: process.env.PW_TRACE === 'on' ? 'on' : 'on-first-retry',
    // CI records video for every test: the suite is small and the PR media
    // comment (scripts/pr-media-comment.mjs) attaches evidence for passing
    // runs too. Revisit if the suite grows enough to hurt the time budget.
    // Screenshots are staged explicitly via helpers/snap.ts (initial state +
    // one per UI state change); the automatic one only fires on failure.
    // Explicit size: Playwright otherwise scales recordings down to fit
    // 800x800, which caps the gif resolution at 800px wide.
    video: process.env.CI
      ? { mode: 'on', size: { width: 1280, height: 720 } }
      : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @app/api',
      cwd: root,
      port: 8787,
      reuseExistingServer: !process.env.CI,
      env: {
        ...(process.env as Record<string, string>),
        PORT: '8787',
        MOCK_DELAY_MS: '20',
      },
    },
    {
      command: 'npm run dev -w @app/web',
      cwd: root,
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
