import type { Page, TestInfo } from "@playwright/test";

// Stage screenshot: call once on the initial state and once after every UI
// state change (n changes -> n+1 snaps). The PR media comment renders these
// in order with their labels, so reviewers see the progression, not just the
// final frame. Attachment names must keep the `stage: ` prefix — the media
// script keys on it.
export async function snap(page: Page, testInfo: TestInfo, label: string) {
  const index = testInfo.attachments.filter((a) => a.name.startsWith("stage: ")).length + 1;
  const file = testInfo.outputPath(
    `stage-${index}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
  );
  await page.screenshot({ path: file });
  await testInfo.attach(`stage: ${label}`, {
    path: file,
    contentType: "image/png",
  });
}
