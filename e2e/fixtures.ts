import { test as base } from "@playwright/test";

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

export const test = base.extend<{ stepNarration: void }>({
  // Worker DB isolation (apps/api/src/e2e-schema.ts): every request names its
  // worker slot so the api routes ticket-domain queries to that worker's
  // schema. parallelIndex (not workerIndex) — a crashed worker's replacement
  // reuses the slot, and with it the schema its predecessor provisioned.
  // Browser contexts carry a cookie: it is the only channel that also rides
  // the WebSocket upgrade. The request fixture builds its jar from storageState
  // alone, so it carries the header instead (extraHTTPHeaders feeds both the
  // request fixture and page fetches; the api accepts either).
  context: async ({ context, baseURL }, use, testInfo) => {
    if (baseURL) {
      await context.addCookies([
        { name: "e2e_worker", value: String(testInfo.parallelIndex), url: baseURL },
      ]);
    }
    await use(context);
  },
  // browserName の分割代入は Playwright の「fixture 第1引数はオブジェクト
  // パターン必須」と oxlint の no-empty-pattern を両立させるための無害な依存。
  extraHTTPHeaders: async ({ browserName: _ }, use, testInfo) => {
    await use({ "x-e2e-worker": String(testInfo.parallelIndex) });
  },
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
