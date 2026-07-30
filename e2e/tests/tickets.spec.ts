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
      await test.step("チケットページを読み込む", async () => {
        await page.goto("/tickets");
        // シード3件の存在をアンカーで確認する。絶対件数は使わない: E2E ファイル群は
        // 1つのDBを共有するため、他ファイルの create が並走すると行数は増えうる
        for (const subject of [
          "Cannot login to dashboard",
          "Billing question",
          "Feature request: dark mode",
        ]) {
          await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        }
        await snap(page, testInfo, "初期表示");
      });

      await test.step("新規チケットフォームを開く", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await expect(page.getByLabel("Subject")).toBeVisible();
        await snap(page, testInfo, "作成フォーム");
      });

      await test.step("新規チケットを送信する", async () => {
        await page.getByLabel("Subject").fill("Printer on fire");
        await page.getByRole("button", { name: "Create" }).click();
        // 絶対件数・先頭位置は使わない(共有DBに並走 create が乗りうるため)。
        // 「作成した行が現れ、エラーが無い」ことが本質
        await expect(
          page.getByTestId("ticket-row").filter({ hasText: "Printer on fire" }),
        ).toBeVisible();
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "作成後");
      });

      // Structural assertion: roles and order only. Each subject is a router
      // Link, so it surfaces as a `link` node inside its listitem. The first
      // row is the just-created ticket; the three seeds follow.
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
      - list:
        - listitem:
          - link /Printer on fire/
        - listitem:
          - link /Feature request/
        - listitem:
          - link /Billing question/
        - listitem:
          - link /Cannot login to dashboard/
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
      await test.step("チケットページを読み込む", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        before = await page.getByTestId("ticket-row").count();
        await snap(page, testInfo, "初期表示");
      });

      await test.step("空の件名で送信する", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByRole("button", { name: "Create" }).click();
      });

      await test.step("バリデーションエラー表示を確認する", async () => {
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
      await page.route("**/api/rpc/**", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "boom" } }),
        }),
      );

      await test.step("一覧取得が失敗する状態でチケットページを読み込む", async () => {
        await page.goto("/tickets");
      });

      await test.step("読み込みエラー表示を確認する", async () => {
        await expect(page.getByTestId("tickets-load-error")).toBeVisible();
        await expect(page.getByTestId("ticket-row")).toHaveCount(0);
        await snap(page, testInfo, "読み込みエラー");
      });
    },
  );
});
