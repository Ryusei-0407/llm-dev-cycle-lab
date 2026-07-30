import { expect, test } from "@playwright/test";
import { snap } from "../helpers/snap";

// Full-stack test against the real API for the reply-draft feature (spec:
// specs/reply-draft.md). No route mocking — the draft streams from the real
// /api/tickets/draft over the deterministic mock adapter (LLM_PROVIDER=mock).
// Assertions are structural only — "a non-empty draft arrived without errors" —
// the exact shape the nightly real-Gemini smoke lane uses (LLM_SMOKE=1).
// Switching LLM_PROVIDER to a real provider requires no changes here: draft
// *content* is never asserted. The chromium project is authenticated as the
// seeded agent (playwright.config.ts).
const DRAFT_SUBJECT = "Cannot login to dashboard";

test.describe("reply-draft against the real backend @feature-reply-draft @backend", () => {
  test(
    "full-stack draft renders a non-empty streamed panel",
    {
      annotation: {
        type: "description",
        description:
          "実APIを通した Generate draft から draft-panel が空でなく draft-error も出ない全経路を、内容ではなく構造として検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("チケットを開く", async () => {
        await page.goto("/tickets");
        await page.getByTestId("ticket-link").filter({ hasText: DRAFT_SUBJECT }).click();
        await expect(page.getByTestId("ticket-subject")).toContainText(DRAFT_SUBJECT);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("ドラフト生成を要求する", async () => {
        await page.getByTestId("generate-draft").click();
        await snap(page, testInfo, "ドラフト生成中");
      });

      await test.step("空でないドラフトを受信する", async () => {
        await expect(page.getByTestId("draft-streaming")).toBeHidden({ timeout: 30_000 });
        await expect(page.getByTestId("draft-panel")).not.toBeEmpty();
        await expect(page.getByTestId("draft-error")).toBeHidden();
        await snap(page, testInfo, "ドラフト表示");
      });
    },
  );
});
