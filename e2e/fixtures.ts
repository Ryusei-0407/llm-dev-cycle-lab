import { test as base } from "@playwright/test";
import { resetStackDb, startStack, type WorkerStack } from "./worker-stack";

// Playwright 組み込みの録画オーバーレイ(video.show.test)は、ステップ名の前に
// 必ず英語の titlePath(ファイル名 › describe名 › テスト名)を重ねて描画する。
// 録画に残したいのは日本語の test.step ナレーションだけなので、組み込み
// オーバーレイは無効化し(playwright.config で show.test を設定しない)、
// 代わりに現在のステップ名だけを自前で描く。駆動には組み込みと同じ
// _onUserStepBegin/End フックを使う(test.step 実行時に無条件で呼ばれる)。
//
// page.screencast.showOverlay はビデオ専用オーバーレイ(pointer-events:none で
// ページ操作・aria スナップショットに干渉しない)。公式スキルのリファレンスに
// 載る実APIだが公開 .d.ts には型が無いため、使う分だけ最小型でキャストする。

type OverlayHandle = { dispose(): Promise<void> };
type ScreencastOverlay = {
  showOverlay(html: string, options?: { duration?: number }): Promise<OverlayHandle>;
};
type StepHooks = {
  _onUserStepBegin?: (title: string) => Promise<void> | void;
  _onUserStepEnd?: () => Promise<void> | void;
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const overlayHtml = (title: string) =>
  `<div style="position:absolute;left:50%;bottom:20px;transform:translateX(-50%);` +
  `max-width:82%;padding:8px 16px;background:rgba(0,0,0,0.72);border-radius:10px;` +
  `font-size:20px;line-height:1.4;color:#fff;` +
  `font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;text-align:center;">` +
  `${escapeHtml(title)}</div>`;

export const test = base.extend<
  { stepNarration: void; dbReset: void },
  { workerStack: WorkerStack }
>({
  // Worker-per-stack isolation (worker-stack.ts): this worker's own postgres
  // container + api + web dev server. Tests reach ONLY this stack (baseURL
  // below), so nothing another worker does can be observed here.
  // browser への依存は Playwright の「fixture 第1引数はオブジェクトパターン
  // 必須」と oxlint の no-empty-pattern を両立させるための無害な参照。
  workerStack: [
    async ({ browser: _ }, use, workerInfo) => {
      const stack = await startStack(workerInfo.workerIndex);
      await use(stack);
      await stack.stop();
    },
    // スタック起動(コンテナ+api+vite)はコールドスタート同士が並ぶと 30s の
    // 既定 fixture タイムアウトを超えることがある(worker 数ぶんの vite が同時に
    // 立つ初回)。起動は worker 毎に1回きりなので余裕を持たせる。
    { scope: "worker", auto: true, timeout: 120_000 },
  ],
  baseURL: async ({ workerStack }, use) => {
    await use(workerStack.webURL);
  },
  // Every test starts from the identical database state: schema + seed +
  // fixed-sid sessions, applied to this worker's own container (~0.1-0.3s).
  // Retries therefore reproduce the exact initial conditions of the first
  // attempt instead of inheriting its leftovers.
  dbReset: [
    async ({ workerStack }, use) => {
      await resetStackDb(workerStack.dbURL);
      await use();
    },
    { auto: true },
  ],
  stepNarration: [
    async ({ page }, use, testInfo) => {
      // 録画が無いラン(ローカルの retain-on-failure 等)では screencast が
      // 非アクティブなので、オーバーレイ処理自体を行わない。
      // DISABLE_STEP_OVERLAY はナレーション描画を止める明示的なエスケープハッチ。
      if (!process.env.CI || process.env.DISABLE_STEP_OVERLAY) {
        await use();
        return;
      }
      const screencast = page.screencast as unknown as ScreencastOverlay;
      const hooks = testInfo as unknown as StepHooks;
      const stack: string[] = [];
      let handle: OverlayHandle | undefined;
      // 録画はタブ生成直後(about:blank の白画面)から始まる。その時点で
      // ステップ名だけ重ねると「白画面のまま操作している」ように見えるため、
      // 最初の実ページの DOM 構築完了までオーバーレイを保留する。
      let painted = false;
      const render = async () => {
        await handle?.dispose().catch(() => {});
        handle = undefined;
        const title = stack.at(-1);
        if (!title || !painted) return;
        handle = await screencast.showOverlay(overlayHtml(title)).catch(() => undefined);
      };
      page.on("domcontentloaded", () => {
        if (!painted && page.url() !== "about:blank") {
          painted = true;
          void render();
        }
      });
      hooks._onUserStepBegin = async (title) => {
        stack.push(title);
        await render();
      };
      hooks._onUserStepEnd = async () => {
        stack.pop();
        await render();
      };
      await use();
      await handle?.dispose().catch(() => {});
      hooks._onUserStepBegin = undefined;
      hooks._onUserStepEnd = undefined;
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
