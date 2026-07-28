import { expect, test } from '@playwright/test';
import { snap } from '../helpers/snap';

// Full-stack tests against the real API (mock provider). Assertions are
// structural only — "a non-empty reply arrived without errors" — which is the
// exact shape a real-LLM smoke lane uses. Switching LLM_PROVIDER to a real
// provider later requires no changes here.
test.describe('chat against the real backend @backend @feature-chat', () => {
  test('full-stack roundtrip renders a non-empty streamed reply', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await page.getByLabel('Message').fill('Hello backend');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('typing-indicator')).toBeVisible();
    await snap(page, testInfo, 'streaming');
    await expect(page.getByTestId('typing-indicator')).toBeHidden({
      timeout: 30_000,
    });
    await expect(page.getByTestId('message-assistant')).not.toBeEmpty();
    await expect(page.getByTestId('error-banner')).toBeHidden();
    await snap(page, testInfo, 'reply rendered');
  });

  test('surfaces a provider failure as an error banner', async ({ page }, testInfo) => {
    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await page.getByLabel('Message').fill('__error__');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByLabel('Message')).toBeEnabled();
    await snap(page, testInfo, 'error shown');
  });
});
