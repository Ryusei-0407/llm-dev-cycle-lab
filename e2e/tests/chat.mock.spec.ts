import { expect, test } from '@playwright/test';
import { snap } from '../helpers/snap';
import { sseBody } from '../helpers/sse';

// Mock-first E2E: the /api/chat contract is stubbed at the network layer, so
// these tests are deterministic and need no backend or LLM. They verify the
// UI plumbing only — response *quality* belongs to the evals lane, not here.
// Steps mirror the user journey so traces and reports read as a narrative.
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

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, '初期表示');
    });

    await test.step('send a message', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('message-user')).toContainText('Hello');
      await expect(page.getByTestId('typing-indicator')).toBeVisible();
      await snap(page, testInfo, 'ストリーミング中');
    });

    await test.step('receive the streamed reply', async () => {
      await expect(page.getByTestId('typing-indicator')).toBeHidden();
      await expect(page.getByTestId('message-assistant')).toContainText(
        'Hello from the mock!',
      );
      await expect(page.getByTestId('error-banner')).toBeHidden();
      await snap(page, testInfo, '応答表示');
    });

    // Structural assertion: roles and order, not pixels or exact prose —
    // the shape that must survive when reply content varies.
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
      await snap(page, testInfo, '初期表示');
    });

    await test.step('send a message that fails', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
    });

    await test.step('see the error and recover', async () => {
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await expect(page.getByTestId('message-assistant')).toHaveCount(0);
      // The user can immediately try again.
      await expect(page.getByLabel('Message')).toBeEnabled();
      await snap(page, testInfo, 'エラー表示');
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

    await test.step('load the app', async () => {
      await page.goto('/');
      await snap(page, testInfo, '初期表示');
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    });

    await test.step('start streaming', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await snap(page, testInfo, 'ストリーミング中(Stopボタン表示)');
    });

    await test.step('stop the stream', async () => {
      await page.getByRole('button', { name: 'Stop' }).click();
      // Must settle well before the 4s fulfil would end the stream anyway.
      await expect(page.getByTestId('typing-indicator')).toBeHidden({
        timeout: 1500,
      });
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
      // Cancelling is not an error, and the user can immediately send again.
      await expect(page.getByTestId('error-banner')).toBeHidden();
      await expect(page.getByLabel('Message')).toBeEnabled();
      await snap(page, testInfo, '停止後');
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
      await snap(page, testInfo, '初期表示');
    });

    await test.step('stream fails mid-way', async () => {
      await page.getByLabel('Message').fill('Hello');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('message-assistant')).toContainText('Partial');
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await snap(page, testInfo, '部分応答とエラー表示');
    });
  });
});
