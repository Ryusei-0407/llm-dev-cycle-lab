import { expect, test } from '@playwright/test';
import { snap } from '../helpers/snap';
import { sseBody } from '../helpers/sse';

// Mock-first E2E: the /api/chat contract is stubbed at the network layer, so
// these tests are deterministic and need no backend or LLM. They verify the
// UI plumbing only — response *quality* belongs to the evals lane, not here.
test.describe('chat with mocked API @feature-chat', () => {
  test('sends a message and renders the streamed reply @smoke', async ({ page }, testInfo) => {
    await page.route('**/api/chat', async (route) => {
      // Delay so the typing indicator is observable (and snapshottable)
      // before fulfilment.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['Hello ', 'from ', 'the ', 'mock!']),
      });
    });

    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('message-user')).toContainText('Hello');
    await expect(page.getByTestId('typing-indicator')).toBeVisible();
    await snap(page, testInfo, 'streaming');
    await expect(page.getByTestId('typing-indicator')).toBeHidden();
    await expect(page.getByTestId('message-assistant')).toContainText(
      'Hello from the mock!',
    );
    await expect(page.getByTestId('error-banner')).toBeHidden();
    await snap(page, testInfo, 'reply rendered');
  });

  test('shows an error banner when the API returns 500', async ({ page }, testInfo) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      }),
    );

    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('message-assistant')).toHaveCount(0);
    // The user can immediately try again.
    await expect(page.getByLabel('Message')).toBeEnabled();
    await snap(page, testInfo, 'error shown');
  });

  // Pinned by adversarial review: the Stop button could be deleted outright
  // without any test noticing. Asserts both spec conditions: visible only
  // while streaming, and clicking it actually cancels the request.
  test('stop cancels a streaming response', async ({ page }, testInfo) => {
    await page.route('**/api/chat', async (route) => {
      // Long delay keeps the request in-flight so Stop is observable; the
      // fulfil below only matters if stop is broken (and is then too late
      // for the 1.5s assertion, which is the point).
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route
        .fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody(['too late']),
        })
        .catch(() => {}); // request may already be aborted
    });

    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await snap(page, testInfo, 'streaming, stop available');
    await page.getByRole('button', { name: 'Stop' }).click();

    // Must settle well before the 4s fulfil would end the stream anyway.
    await expect(page.getByTestId('typing-indicator')).toBeHidden({
      timeout: 1500,
    });
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    // Cancelling is not an error, and the user can immediately send again.
    await expect(page.getByTestId('error-banner')).toBeHidden();
    await expect(page.getByLabel('Message')).toBeEnabled();
    await snap(page, testInfo, 'stopped');
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

    await page.goto('/');
    await snap(page, testInfo, 'initial');
    await page.getByLabel('Message').fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('message-assistant')).toContainText('Partial');
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await snap(page, testInfo, 'partial text with error');
  });
});
