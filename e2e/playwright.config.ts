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
  // Sweep away any temporary postgres container e2e-api.mjs provisioned but
  // whose stop signal was not delivered (shell wrapping / SIGKILL on webServer
  // teardown). Runs after all webServers are down. Spec: specs/database.md.
  globalTeardown: path.join(configDir, "global-teardown.ts"),
  fullyParallel: true,
  // VRT(visual.spec.ts)の baseline は linux(CI)でのみ生成・比較する。
  // darwin はフォントレンダリング差で必ずずれるため、ローカルでは snapshot
  // 比較をスキップ(テスト自体は走る = ページが壊れていないことは見る)。
  // baseline 更新は update-snapshots ワークフローを対象ブランチへ dispatch。
  ignoreSnapshots: !process.env.CI,
  expect: {
    toHaveScreenshot: {
      // アニメーション停止 + キャレット非表示で撮影を安定化。maxDiffPixels は
      // アンチエイリアスの1px 揺れを許す最小限(意味のある UI 変化は数百px 単位)。
      animations: "disabled" as const,
      caret: "hide" as const,
      maxDiffPixels: 64,
      // 画素ごとの色距離しきい値。既定 0.2 だとダークテーマの面変化が全て
      // サブしきい値になり VRT が盲目化する(canvas #010102 vs surface-1
      // #0a0a0c は YIQ 距離 ≈3.5%、hairline 枠線でも ≈14% — カラムが数百px
      // 伸びる変化が差分0扱いだった)。同一プラットフォーム(linux CI)の
      // 描画は決定論的なので、しきい値を落としてもAAノイズは出ない。
      threshold: 0.02,
    },
  },
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
    // trace-analyst can mine timings.
    // Default is retain-on-failure, NOT on-first-retry: on-first-retry records
    // only the retry attempt, so a flaky test (fails once, retry passes) leaves
    // no trace of the attempt that actually failed — the one piece of evidence
    // a flake postmortem needs (network bodies included; kanban D&D フレークは
    // このトレース内のネットワーク証跡で原因確定した). retain-on-failure traces
    // every attempt and keeps only failing ones, so flakes self-evidence in CI.
    trace: process.env.PW_TRACE === "on" ? "on" : "retain-on-failure",
    // CI records video for every test: the suite is small and the PR media
    // comment (scripts/pr-media-comment.mjs) attaches evidence for passing
    // runs too. Revisit if the suite grows enough to hurt the time budget.
    // Screenshots are staged explicitly via helpers/snap.ts (initial state +
    // one per UI state change); the automatic one only fires on failure.
    // Explicit size: Playwright otherwise scales recordings down to fit
    // 800x800, which caps the gif resolution at 800px wide.
    // show.actions は操作要素のハイライト + アクション字幕 + カーソル描画
    // (v1.59 の公式スクリーンキャスト注釈)。テスト実行速度には影響しない —
    // 「ゆっくり再生」は録画側でなく GIF 変換(setpts 0.5x)で行う
    video: process.env.CI
      ? {
          mode: "on" as const,
          size: { width: 1280, height: 720 },
          // オーバーレイ方針: 録画に残す文字は日本語の test.step ナレーションのみ。
          // - actions レイヤーは cursor/要素ハイライト(クリックの視認性)のために
          //   残すが、英語のアクション字幕は Playwright 内部でハードコードされ字幕
          //   だけの無効化APIが無いため fontSize を 1px に落として実質不可視にする
          //   (カーソルと要素ハイライトは fontSize と独立に描画されるので影響なし)。
          // - test レイヤー(show.test)は設定しない。組み込みオーバーレイは英語の
          //   titlePath(ファイル名 › describe名 › テスト名)を必ずステップ前に重ねる
          //   ため。日本語ステップだけの描画は e2e/fixtures.ts の自前オーバーレイが
          //   担う(page.screencast.showOverlay 経由)。
          show: {
            actions: {
              cursor: "pointer" as const,
              position: "top-left" as const,
              duration: 700,
              fontSize: 1,
            },
          },
        }
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
  // chromium (機能E2E) のサーバはここでは起動しない: worker 毎に独立スタック
  // (postgres コンテナ + api + web dev)を e2e/worker-stack.ts の worker fixture
  // が worker 専用ポートで起動・破棄する。ここに残る webServer は components
  // プロジェクト(ギャラリーの静的配信のみ、API/DB 不要)のための web 1本。
  webServer: [
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
