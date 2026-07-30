import { expect, test } from "@playwright/test";

// コンポーネント単位の VRT(Storybook 相当・依存ゼロ)。各 *.story.tsx の
// VisualCatalog(全状態を並べたカタログ)を単体マウントし、コンポーネントの
// 描画範囲だけを baseline 比較する。差分はページ VRT と同じ経路で PR コメントに
// 3枚組/変更前後として表示される。baseline 運用も同じ(linux 限定、
// update-snapshots ワークフローで更新 — ファイル名が visual.spec.ts なので
// 既存ワークフローの対象に自動で含まれる)。
// VRT は静的検証 — 録画はノイズなので撮らない(成果物はスクリーンショット)。
// video は worker スコープのオプションなのでファイルのトップレベルに置く。
test.use({ video: "off" });

test.describe("component visual regression @feature-visual @visual @component", () => {
  const catalogs = [
    { story: "components/status-badge/VisualCatalog", shot: "status-badge.png" },
    { story: "components/message-thread/VisualCatalog", shot: "message-thread.png" },
    { story: "components/ticket-list/VisualCatalog", shot: "ticket-list.png" },
  ];

  for (const { story, shot } of catalogs) {
    test(
      `${story.split("/")[1]} catalog`,
      {
        annotation: {
          type: "description",
          description: `${story} の全状態カタログを baseline と比較`,
        },
      },
      async ({ page, mount }) => {
        await mount(story);
        await expect(page.locator("#root > *").first()).toBeVisible();
        // #root の中身(カタログの実寸)だけを切り出して撮る — コンポーネント
        // 単位の差分になり、どの部品が変わったかが一目で分かる。
        await expect(page.locator("#root")).toHaveScreenshot(shot);
        // 成功時もカタログ画像を添付し、PR コメントにスクリーンショットとして出す。
        // (body 添付は path を持たずメディア収集から漏れるため、保存して path 添付)
        const name = shot.replace(/\.png$/, "");
        const file = test.info().outputPath(`shot-${name}.png`);
        await page.locator("#root").screenshot({ path: file });
        await test.info().attach(`shot: ${name}`, { path: file, contentType: "image/png" });
      },
    );
  }
});
