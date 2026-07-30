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
      const render = async () => {
        await handle?.dispose().catch(() => {});
        handle = undefined;
        const title = stack.at(-1);
        if (!title) return;
        handle = await screencast.showOverlay(overlayHtml(title)).catch(() => undefined);
      };
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
