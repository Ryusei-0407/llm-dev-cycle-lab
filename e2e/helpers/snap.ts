import type { Page, TestInfo } from '@playwright/test';

/**
 * 段階スクリーンショット: 初期状態で1回 + UIの状態遷移ごとに1回呼ぶ
 * (n回変化する画面なら n+1 枚)。PRメディアコメントがラベル付き・時系列順に
 * 描画するため、レビュアーは最終フレームだけでなく遷移の過程を追える。
 *
 * 制約: attachment 名の `stage: ` プレフィックスは scripts/pr-media-comment.mjs
 * がキーにしているので変更できない。
 */
export async function snap(page: Page, testInfo: TestInfo, label: string) {
  const index =
    testInfo.attachments.filter((a) => a.name.startsWith('stage: ')).length + 1;
  const file = testInfo.outputPath(
    `stage-${index}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
  );
  await page.screenshot({ path: file });
  await testInfo.attach(`stage: ${label}`, {
    path: file,
    contentType: 'image/png',
  });
}
