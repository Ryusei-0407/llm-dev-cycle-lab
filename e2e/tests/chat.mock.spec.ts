import { expect, test } from '@playwright/test';
import { sseBody } from '../helpers/sse';

// Mock-first E2E: the /api/chat contract is stubbed at the network layer, so
// these tests are deterministic and need no backend or LLM. They verify the
// UI plumbing only — response *quality* belongs to the evals lane, not here.
test.describe('chat with mocked API @feature-chat', () => {
  test('sends a message and renders the streamed reply @smoke', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      // Delay so the typing indicator is observable before fulfilment.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['Hello ', 'from ', 'the ', 'mock!']),
      });
    });

    await page.goto('/');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('message-user')).toContainText('Hello');
    await expect(page.getByTestId('typing-indicator')).toBeVisible();
    await expect(page.getByTestId('typing-indicator')).toBeHidden();
    await expect(page.getByTestId('message-assistant')).toContainText(
      'Hello from the mock!',
    );
    await expect(page.getByTestId('error-banner')).toBeHidden();
  });

  test('shows an error banner when the API returns 500', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('message-assistant')).toHaveCount(0);
    // The user can immediately try again.
    await expect(page.getByLabel('Message')).toBeEnabled();
  });

  test('keeps partial text and shows an error when the stream fails mid-way', async ({
    page,
  }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['Partial '], { errorAfter: true }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('message-assistant')).toContainText('Partial');
    await expect(page.getByTestId('error-banner')).toBeVisible();
  });
});
