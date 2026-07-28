import { expect, test } from '@playwright/test';

/**
 * slow-hint のコンポーネントテスト(Playwright CT / stories & galleries)
 *
 * - この層にある理由: 10秒のタイマーを決定的に進めるには page.clock が必要。
 *   Playwright の clock はページ読み込み前にコンテキストレベルでタイマーを
 *   差し替えるため、Vitest Browser Mode の fake timers(ロード後のパッチ)より確実
 * - story(src/App.story.tsx)が停止したままのSSEストリームを所有し、
 *   テストは window.__stream 経由で外からストリームを進める
 */
test.describe('slow-hint @component @feature-slow-hint', () => {
  test('appears after 10s of stalled streaming and clears on completion', async ({
    page,
    mount,
  }) => {
    await page.clock.install();
    const component = await mount('App/StalledStream');

    await component.getByLabel('Message').fill('Hello');
    await component.getByRole('button', { name: 'Send' }).click();

    // 閾値(10秒)の前は非表示、超えたら表示
    await expect(component.getByTestId('slow-hint')).toBeHidden();
    await page.clock.fastForward(10_000);
    await expect(component.getByTestId('slow-hint')).toBeVisible();

    // ストリームを完了させるとヒントは消え、応答が描画される
    await page.evaluate(() => {
      window.__stream.push('Late reply');
      window.__stream.done();
    });
    await expect(component.getByTestId('message-assistant')).toContainText(
      'Late reply',
    );
    await expect(component.getByTestId('slow-hint')).toBeHidden();
  });
});
