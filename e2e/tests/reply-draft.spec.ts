import { expect, test } from "@playwright/test";
import { aguiDraftBody, aguiDraftErrorBody } from "../helpers/agui-sse";
import { snap } from "../helpers/snap";

// Mock-first E2E for the reply-draft feature (spec: specs/reply-draft.md). The
// /api/tickets/draft SSE contract is stubbed at the network layer so these are
// deterministic and need no LLM. They verify UI plumbing only — Generate draft
// → streamed draft-panel → Use draft transcribes into the Reply textarea, plus
// the two handled failures. Draft *quality* is not asserted here (that is the
// @backend smoke lane). The chromium project is authenticated as the seeded
// agent (playwright.config.ts), so navigation to a ticket detail works as in
// ticket-detail.spec.ts. Fixed draft line from the mock adapter contract:
//   Draft reply for "Cannot login to dashboard": Thanks for reaching out. ...
const DRAFT_SUBJECT = "Cannot login to dashboard";
const DRAFT_TEXT = `Draft reply for "${DRAFT_SUBJECT}": Thanks for reaching out. We are looking into your issue and will follow up shortly.`;

// Splits the fixed draft into a few deltas so the mocked stream mirrors real
// chunked streaming (content is the join, so order and completeness are what
// the UI must render).
function draftDeltas(text: string): string[] {
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

async function openLoginTicket(page: import("@playwright/test").Page) {
  await page.goto("/tickets");
  await page.getByTestId("ticket-link").filter({ hasText: DRAFT_SUBJECT }).click();
  await expect(page.getByTestId("ticket-subject")).toContainText(DRAFT_SUBJECT);
}

test.describe("reply-draft with mocked API @feature-reply-draft", () => {
  test(
    "generates a draft and transcribes it into the reply @smoke",
    {
      annotation: {
        type: "description",
        description:
          "詳細ページで Generate draft を押すと draft-panel に固定文がストリーミング表示され、Use draft で Reply textarea に全文が転写される主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await page.route("**/api/tickets/draft", async (route) => {
        // Delay so the streaming indicator is observable (and snappable)
        // before the body arrives.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: aguiDraftBody(draftDeltas(DRAFT_TEXT)),
        });
      });

      await test.step("open the ticket from the list", async () => {
        await openLoginTicket(page);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("request a draft", async () => {
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-streaming")).toBeVisible();
        await snap(page, testInfo, "ドラフト生成中");
      });

      await test.step("see the streamed draft", async () => {
        await expect(page.getByTestId("draft-streaming")).toBeHidden();
        await expect(page.getByTestId("draft-panel")).toContainText(DRAFT_TEXT);
        await expect(page.getByTestId("draft-error")).toBeHidden();
        await snap(page, testInfo, "ドラフト表示");
      });

      await test.step("use the draft", async () => {
        await page.getByTestId("use-draft").click();
        await expect(page.getByLabel("Reply")).toHaveValue(DRAFT_TEXT);
        await snap(page, testInfo, "返信欄へ転写");
      });

      // Structural assertion: roles and order of the draft shell — the shape
      // that must survive when the draft prose varies (real-LLM lane).
      await expect(page.getByTestId("draft-panel")).toMatchAriaSnapshot(`
      - button "Use draft"
    `);
    },
  );

  test(
    "shows a draft error when the API returns 500",
    {
      annotation: {
        type: "description",
        description:
          "Generate draft のリクエストが 500 を返したとき draft-error が表示され、Reply textarea が空のままであることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await page.route("**/api/tickets/draft", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        }),
      );

      await test.step("open the ticket", async () => {
        await openLoginTicket(page);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("request a draft that fails", async () => {
        await page.getByTestId("generate-draft").click();
      });

      await test.step("see the draft error", async () => {
        await expect(page.getByTestId("draft-error")).toBeVisible();
        // The reply was never populated, so the agent can still write manually.
        await expect(page.getByLabel("Reply")).toHaveValue("");
        await snap(page, testInfo, "ドラフトエラー");
      });
    },
  );

  test(
    "keeps partial draft text and shows an error when the stream fails mid-way",
    {
      annotation: {
        type: "description",
        description:
          "ドラフトのストリームが途中で失敗したとき、それまでの部分文を draft-panel に保持しつつ draft-error を表示することを検証",
      },
    },
    async ({ page }, testInfo) => {
      const partial = "Draft reply for ";
      await page.route("**/api/tickets/draft", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: aguiDraftErrorBody([partial]),
        }),
      );

      await test.step("open the ticket", async () => {
        await openLoginTicket(page);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("stream fails mid-way", async () => {
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-panel")).toContainText(partial);
        await expect(page.getByTestId("draft-error")).toBeVisible();
        await snap(page, testInfo, "部分ドラフトとエラー");
      });
    },
  );
});
