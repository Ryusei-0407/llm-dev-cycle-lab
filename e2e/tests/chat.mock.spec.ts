import { expect, test } from '@playwright/test';
import { snap } from '../helpers/snap';
import { sseBody } from '../helpers/sse';

/**
 * チャットUIのE2E(モックAPI層)— 全PRで実行される主力レーン
 *
 * - 検証対象: UIの配管(送信 → 表示 → ストリーム完了 → エラー処理)
 * - モック方針: `/api/chat` をネットワーク層(page.route)で固定するため、
 *   バックエンドもLLMも不要で、結果は決定的
 * - 検証しないこと: 応答の「品質」(evalsレーンの担当)
 * - test.step はユーザー操作の時系列に対応させ、trace とPRメディアが
 *   物語として読めるようにしている
 */
test.describe('chat with mocked API @feature-chat', () => {
  test('sends a message and renders the streamed reply @smoke', async ({ page }, testInfo) => {
    await page.route('**/api/chat', async (route) => {
      // 応答を600ms遅らせ、タイピングインジケータを観測(スクショ)可能にする
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['Hello ', 'from ', 'the ', 'mock!']),
      });
    });

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, 'initial');
    });

    await test.step('send a message', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('message-user')).toContainText('Hello');
      await expect(page.getByTestId('typing-indicator')).toBeVisible();
      await snap(page, testInfo, 'streaming');
    });

    await test.step('receive the streamed reply', async () => {
      await expect(page.getByTestId('typing-indicator')).toBeHidden();
      await expect(page.getByTestId('message-assistant')).toContainText(
        'Hello from the mock!',
      );
      await expect(page.getByTestId('error-banner')).toBeHidden();
      await snap(page, testInfo, 'reply rendered');
    });

    // 構造アサーション: 応答内容が変わっても維持されるべき role と順序だけを固定する
    await expect(page.locator('main')).toMatchAriaSnapshot(`
      - heading "LLM Dev-Cycle Lab Chat"
      - list:
        - listitem: /user/
        - listitem: /assistant/
      - textbox "Message"
      - button "Send"
    `);
  });

  test('shows an error banner when the API returns 500', async ({ page }, testInfo) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      }),
    );

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, 'initial');
    });

    await test.step('send a message that fails', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
    });

    await test.step('see the error and recover', async () => {
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await expect(page.getByTestId('message-assistant')).toHaveCount(0);
      // 失敗後もユーザーがすぐ再送できる状態であること
      await expect(page.getByLabel('Message')).toBeEnabled();
      await snap(page, testInfo, 'error shown');
    });

    await expect(page.locator('main')).toMatchAriaSnapshot(`
      - alert: /request failed/
      - list:
        - listitem: /user/
      - textbox "Message"
    `);
  });

  test('stop cancels a streaming response', async ({ page }, testInfo) => {
    await page.route('**/api/chat', async (route) => {
      // タイミング設計(このテストの核):
      //   4秒間リクエストを滞留させて Stop ボタンを観測可能にする。
      //   Stop が正しく動けば下の fulfill は実行されない(=abort 済みで失敗してよい)。
      //   Stop が壊れている場合のみ4秒後にストリームが完了するが、
      //   それでは後段の1.5秒アサーションに間に合わない — それが検出条件になる
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route
        .fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody(['too late']),
        })
        .catch(() => {});
    });

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, 'initial');
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    });

    await test.step('start streaming', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await snap(page, testInfo, 'streaming, stop available');
    });

    await test.step('stop the stream', async () => {
      await page.getByRole('button', { name: 'Stop' }).click();
      // 1500ms制限: 4秒後の自然完了より十分前に「停止による」終了を確認する
      await expect(page.getByTestId('typing-indicator')).toBeHidden({
        timeout: 1500,
      });
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
      // 停止はエラーではない(バナーを出さず、すぐ再送できる)
      await expect(page.getByTestId('error-banner')).toBeHidden();
      await expect(page.getByLabel('Message')).toBeEnabled();
      await snap(page, testInfo, 'stopped');
    });
  });

  test('keeps partial text and shows an error when the stream fails mid-way', async ({
    page,
  }, testInfo) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['Partial '], { errorAfter: true }),
      }),
    );

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, 'initial');
    });

    await test.step('stream fails mid-way', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('message-assistant')).toContainText('Partial');
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await snap(page, testInfo, 'partial text with error');
    });
  });
});
