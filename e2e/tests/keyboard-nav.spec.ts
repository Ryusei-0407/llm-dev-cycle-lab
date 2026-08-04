import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the keyboard-nav feature (spec: specs/keyboard-nav.md テスト観点 E2E).
// /tickets の一覧を j / k で行ハイライト移動し、Enter でアクティブ行の詳細へ SPA
// 遷移、詳細から Esc で一覧へ戻る主経路を、実バックエンド(agent)で検証する。
// UI の配管のみを見る: アサーションは data-active 属性と URL で行い、行の識別は
// このテストが作成したアンカー行(件名)で行う(共有シードの順序に依存しない)。
// 途中で「検索/入力系 input にフォーカスして j を押してもアクティブ行が動かない」
// ガード(spec: 入力系フォーカス中は何もしない)も同一テスト内で確認する。
test.describe("keyboard-nav over the tickets list @feature-keyboard-nav", () => {
  test(
    "navigates the list with j/k, opens with Enter, and returns with Esc @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が /tickets で自作のアンカー行を先頭に作り、j で先頭行が data-active、j で 2 行目、k で 1 行目へ移動、入力系 input(Subject)にフォーカス中は j でアクティブ行が動かない、Enter でアクティブ行の詳細 /tickets/<id> へ遷移、Esc で /tickets に戻る主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      const anchor = `KBNav anchor ${Date.now()}`;

      await test.step("チケットページを読み込み、アンカー行を先頭に作る", async () => {
        await page.goto("/tickets");
        // 新規作成した行は先頭に入る(tickets 仕様)。共有シードの順序に依存せず
        // 「先頭 = 自作のアンカー行」という自テスト所有の前提を作る。
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").fill(anchor);
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("ticket-row").filter({ hasText: anchor })).toBeVisible();
        await snap(page, testInfo, "初期表示");
      });

      const anchorRow = page.getByTestId("ticket-row").filter({ hasText: anchor });
      const secondRow = page.getByTestId("ticket-row").nth(1);

      await test.step("j で先頭のアンカー行がアクティブになる", async () => {
        await page.keyboard.press("j");
        await expect(anchorRow).toHaveAttribute("data-active", "true");
        await snap(page, testInfo, "先頭アクティブ");
      });

      await test.step("j で 2 行目へ、k で先頭へ戻る", async () => {
        await page.keyboard.press("j");
        await expect(secondRow).toHaveAttribute("data-active", "true");
        await expect(anchorRow).not.toHaveAttribute("data-active", "true");
        await page.keyboard.press("k");
        await expect(anchorRow).toHaveAttribute("data-active", "true");
        await expect(secondRow).not.toHaveAttribute("data-active", "true");
        await snap(page, testInfo, "j2回k1回で先頭に戻る");
      });

      await test.step("入力系 input フォーカス中は j が無視される", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").click();
        await expect(page.getByLabel("Subject")).toBeFocused();
        await page.keyboard.press("j");
        // ガードにより先頭アクティブ行は動かない("j" は Subject 入力へ入るだけ)。
        await expect(anchorRow).toHaveAttribute("data-active", "true");
        await snap(page, testInfo, "input中はjが無効");
      });

      await test.step("Enter でアクティブ行の詳細へ遷移する", async () => {
        // フォームを閉じてフォーカスを一覧文脈へ戻す(Escape はまず入力系ガードで
        // 一覧遷移しない — この step の主眼は Enter 遷移)。
        await page.keyboard.press("Escape");
        await page.getByTestId("ticket-list").click();
        await expect(anchorRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/tickets\/[^/]+$/);
        await expect(page.getByTestId("ticket-subject")).toContainText(anchor);
        await snap(page, testInfo, "詳細へ遷移");
      });

      await test.step("Esc で一覧へ戻る", async () => {
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/tickets$/);
        await expect(page.getByTestId("ticket-list")).toBeVisible();
        await snap(page, testInfo, "一覧へ戻る");
      });

      // Structural assertion: 一覧に戻ったあとのリスト構造(role と順序のみ)。
      // 各 subject は router Link なので listitem 内の link として現れる。先頭は
      // 自作アンカー行。
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
      - list:
        - listitem:
          - link /KBNav anchor/
    `);
    },
  );
});
