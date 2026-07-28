import { expect, test } from '@playwright/test';
import { snap } from '../helpers/snap';

/**
 * チャットのE2E(実バックエンド結合)— nightly レーン
 *
 * - 検証対象: フロント → 実API → プロバイダのフルスタック疎通
 * - アサーション方針: 構造のみ(「空でない応答がエラーなしで届いた」)。
 *   これは実LLMスモークと同じ形であり、LLM_PROVIDER を実プロバイダに
 *   切り替えてもこのファイルは無変更で使える
 * - 応答テキストの中身は検証しない(内容は揺れる前提の設計)
 */
test.describe('chat against the real backend @backend @feature-chat', () => {
  test('full-stack roundtrip renders a non-empty streamed reply', async ({
    page,
  }, testInfo) => {
    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, '初期表示');
    });

    await test.step('send a message', async () => {
      await page.getByLabel('Message').fill('Hello backend');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('typing-indicator')).toBeVisible();
      await snap(page, testInfo, 'ストリーミング中');
    });

    await test.step('receive a reply', async () => {
      await expect(page.getByTestId('typing-indicator')).toBeHidden({
        timeout: 30_000,
      });
      await expect(page.getByTestId('message-assistant')).not.toBeEmpty();
      await expect(page.getByTestId('error-banner')).toBeHidden();
      await snap(page, testInfo, '応答表示');
    });

    // 構造アサーション: 応答が非決定的でも成立する検証のみ(role と順序)
    await expect(page.locator('main')).toMatchAriaSnapshot(`
      - list:
        - listitem: /user/
        - listitem: /assistant/
      - textbox "Message"
    `);
  });

  test('surfaces a provider failure as an error banner', async ({ page }, testInfo) => {
    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, '初期表示');
    });

    await test.step('trigger a provider failure', async () => {
      await page.getByLabel('Message').fill('__error__');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await expect(page.getByLabel('Message')).toBeEnabled();
      await snap(page, testInfo, 'エラー表示');
    });
  });
});
