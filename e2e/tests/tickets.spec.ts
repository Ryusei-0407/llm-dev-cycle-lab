import { expect, test } from "@playwright/test";
import { snap } from "../helpers/snap";

// Mock-first E2E for the tickets feature. The happy path runs against the
// deterministic in-memory seed served by the real tRPC route; the failure
// paths stub the tRPC transport at the network layer so they are hermetic.
// These verify UI plumbing only (list → create → status), not data quality.
test.describe("tickets over tRPC @feature-tickets", () => {
  test(
    "lists seeded tickets and creates a new one @smoke",
    {
      annotation: {
        type: "description",
        description: "チケット一覧のシード表示から新規作成して先頭に追加されるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("load the tickets page", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row")).toHaveCount(3);
        await snap(page, testInfo, "初期表示");
      });

      await test.step("open the new ticket form", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await expect(page.getByLabel("Subject")).toBeVisible();
        await snap(page, testInfo, "作成フォーム");
      });

      await test.step("submit a new ticket", async () => {
        await page.getByLabel("Subject").fill("Printer on fire");
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("ticket-row")).toHaveCount(4);
        await expect(page.getByTestId("ticket-row").first()).toContainText("Printer on fire");
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "作成後");
      });

      // Structural assertion: roles and order only. The first row is the
      // just-created ticket; the three seeds follow.
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
      - list:
        - listitem:
          - text: /Printer on fire/
        - listitem:
          - text: /Feature request/
        - listitem:
          - text: /Billing question/
        - listitem:
          - text: /Cannot login to dashboard/
    `);
    },
  );

  test(
    "shows a validation error and keeps the list unchanged for an empty subject",
    {
      annotation: {
        type: "description",
        description:
          "空の件名で作成を試みたときにバリデーションエラーが出て一覧の件数が変わらないことを検証",
      },
    },
    async ({ page }, testInfo) => {
      // 件数は絶対値でなく前後比較にする: ストアはEEラン全体で共有され、
      // 他テストの作成分が混ざりうる(実行順・並列度に依存しない検証にする)
      let before = 0;
      await test.step("load the tickets page", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        before = await page.getByTestId("ticket-row").count();
        await snap(page, testInfo, "初期表示");
      });

      await test.step("submit an empty subject", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByRole("button", { name: "Create" }).click();
      });

      await test.step("see the validation error", async () => {
        await expect(page.getByTestId("ticket-error")).toBeVisible();
        await expect(page.getByTestId("ticket-row")).toHaveCount(before);
        await snap(page, testInfo, "バリデーションエラー");
      });
    },
  );

  test(
    "shows a load error when the list query fails",
    {
      annotation: {
        type: "description",
        description: "一覧取得クエリが失敗したときに読み込みエラー表示に切り替わることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await page.route("**/api/trpc/**", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "boom" } }),
        }),
      );

      await test.step("load the tickets page with a failing list query", async () => {
        await page.goto("/tickets");
      });

      await test.step("see the load error", async () => {
        await expect(page.getByTestId("tickets-load-error")).toBeVisible();
        await expect(page.getByTestId("ticket-row")).toHaveCount(0);
        await snap(page, testInfo, "読み込みエラー");
      });
    },
  );
});
