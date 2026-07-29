import { expect, test } from "@playwright/test";
import { snap } from "../helpers/snap";

// E2E for the ticket-detail feature (spec: specs/ticket-detail.md). Runs against
// the real oRPC routes over the deterministic postgres seed; the chromium
// project is authenticated as the seeded agent (playwright.config.ts), so a
// posted reply is authored by the agent. These verify UI plumbing only
// (open → thread → reply → append/clear, and the two handled failures), not
// message content quality.
test.describe("ticket-detail over oRPC @feature-ticket-detail", () => {
  test(
    "opens a ticket, reads the thread, and posts a reply @smoke",
    {
      annotation: {
        type: "description",
        description:
          "一覧からチケットを開いてシードの会話を読み、返信を投稿してスレッド末尾に自分の返信が追加され入力欄が空になるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("open the ticket from the list", async () => {
        await page.goto("/tickets");
        await page
          .getByTestId("ticket-link")
          .filter({ hasText: "Cannot login to dashboard" })
          .click();
        await expect(page.getByTestId("ticket-subject")).toContainText("Cannot login to dashboard");
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("read the seeded thread", async () => {
        // 相対比較: 件数の絶対値ではなく「シード2件から返信で1件増える」ことを見る。
        await expect(page.getByTestId("message-item")).toHaveCount(2);
        await snap(page, testInfo, "スレッド");
      });

      await test.step("post a reply", async () => {
        const before = await page.getByTestId("message-item").count();
        await page.getByLabel("Reply").fill("Thanks — I've reset your session, please retry.");
        await page.getByRole("button", { name: "Send reply" }).click();
        await expect(page.getByTestId("message-item")).toHaveCount(before + 1);
        await expect(page.getByTestId("message-item").last()).toContainText(
          "I've reset your session",
        );
        await expect(
          page.getByTestId("message-item").last().getByTestId("message-author"),
        ).toHaveText("agent@example.com");
        await expect(page.getByLabel("Reply")).toHaveValue("");
        await expect(page.getByTestId("reply-error")).toBeHidden();
        await snap(page, testInfo, "返信後");
      });

      // Structural assertion: the thread shell (subject, message list, reply
      // control) — roles and order only, survives copy and layout changes.
      await expect(page.getByTestId("message-thread")).toMatchAriaSnapshot(`
      - list:
        - listitem
        - listitem
        - listitem
    `);
    },
  );

  test(
    "shows a not-found panel for an unknown ticket id",
    {
      annotation: {
        type: "description",
        description:
          "存在しない id へ直接アクセスしたときにアプリが落ちず ticket-not-found を表示することを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("navigate directly to a missing ticket", async () => {
        await page.goto("/tickets/00000000-0000-7000-8000-0000000000ff");
      });

      await test.step("see the not-found panel", async () => {
        await expect(page.getByTestId("ticket-not-found")).toBeVisible();
        await expect(page.getByTestId("message-thread")).toBeHidden();
        await snap(page, testInfo, "不在チケット");
      });
    },
  );

  test(
    "rejects an empty reply and leaves the thread unchanged",
    {
      annotation: {
        type: "description",
        description:
          "空のまま Send reply したときに reply-error が出て、スレッドの件数が前後で変わらないことを検証",
      },
    },
    async ({ page }, testInfo) => {
      let before = 0;
      await test.step("open a ticket", async () => {
        await page.goto("/tickets");
        await page.getByTestId("ticket-link").filter({ hasText: "Billing question" }).click();
        await expect(page.getByTestId("message-item").first()).toBeVisible();
        // 件数は絶対値でなく前後比較にする(実行順・並列度・他レーンの返信投稿に依存しない)。
        before = await page.getByTestId("message-item").count();
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("submit an empty reply", async () => {
        await page.getByRole("button", { name: "Send reply" }).click();
      });

      await test.step("see the reply error with the thread unchanged", async () => {
        await expect(page.getByTestId("reply-error")).toBeVisible();
        await expect(page.getByTestId("message-item")).toHaveCount(before);
        await snap(page, testInfo, "返信エラー");
      });
    },
  );
});
