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

  test(
    "(mock) 窓外への移動でアクティブ行が可視化され、行数減でクランプする @pinned",
    {
      annotation: {
        type: "description",
        description:
          "反例の固定: scrollToIndex 追従とクランプの UI 結線はどのテストも実 route を通していなかった。listPage を page.route の固定30件にし、j 連打で可視窓外の行へ移動してもアクティブ行が可視であること(追従)、フィルタで3件に減るとアクティブ index が末尾へクランプされることを検証",
      },
    },
    async ({ page }) => {
      // 幾何の前提(30行 > 可視窓)は共有DBに積まずモックで固定する(POLICY)。
      const ticket = (n: number, priority: string, subject: string) => ({
        id: `00000000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`,
        number: n,
        subject,
        status: "open",
        priority,
        requesterEmail: "customer@example.com",
        assigneeEmail: null,
        labels: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const all = Array.from({ length: 30 }, (_, i) => ticket(i + 1, "medium", `Mock ${i + 1}`));
      const high = Array.from({ length: 3 }, (_, i) => ticket(40 + i, "high", `High ${i + 1}`));
      await page.route("**/api/rpc/tickets/listPage", async (route) => {
        const body = route.request().postDataJSON() as { json?: { priority?: string } };
        const items = body.json?.priority === "high" ? high : all;
        await route.fulfill({ json: { json: { items, nextCursor: null } } });
      });

      await test.step("30件の一覧で j 連打 → 窓外の行がアクティブでも可視", async () => {
        await page.goto("/tickets");
        await expect(
          page.getByTestId("ticket-row").filter({ hasText: /Mock 1(?!\d)/ }),
        ).toBeVisible();
        for (let i = 0; i < 25; i++) await page.keyboard.press("j");
        const active = page.locator('[data-testid="ticket-row"][data-active="true"]');
        // scrollToIndex 追従が無いと窓外の行は DOM ごと消える(仮想化)ため、
        // アクティブ行の可視そのものが追従の検証になる。
        await expect(active).toBeVisible();
        await expect(active).toContainText("Mock 25");
      });

      await test.step("フィルタで 3 件に減るとアクティブ index が末尾へクランプ", async () => {
        await page.getByTestId("filter-priority").selectOption("high");
        await expect(page.getByTestId("ticket-row")).toHaveCount(3);
        const active = page.locator('[data-testid="ticket-row"][data-active="true"]');
        await expect(active).toContainText("High 3");
      });
    },
  );

  test(
    "ガード束: 未選択Enter・修飾キー・パレット開中は無反応、o で詳細が開く @pinned",
    {
      annotation: {
        type: "description",
        description:
          "反例の固定: 未選択での Enter 無反応・修飾キーガード・コマンドパレット表示中のガード(一覧/詳細)・o キーはどのテストにも結線されていなかった。各ガードをミューテーションで外すと red になることを確認済みの反例束",
      },
    },
    async ({ page }, testInfo) => {
      const anchor = `KBNav pin ${testInfo.testId}`;

      await test.step("アンカー行を先頭に作る", async () => {
        await page.goto("/tickets");
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").fill(anchor);
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("ticket-row").filter({ hasText: anchor })).toBeVisible();
        // フォームを閉じ、フォーカスを入力系の外へ戻す。
        await page.keyboard.press("Escape");
        await page.getByTestId("ticket-list").click();
      });

      const anchorRow = page.getByTestId("ticket-row").filter({ hasText: anchor });
      const activeRows = page.locator('[data-testid="ticket-row"][data-active="true"]');

      await test.step("未選択のまま Enter → 遷移しない", async () => {
        await expect(activeRows).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/tickets$/);
      });

      await test.step("修飾キー付き j → アクティブ行は生まれない", async () => {
        await page.keyboard.press("Control+j");
        await page.keyboard.press("Alt+j");
        await expect(activeRows).toHaveCount(0);
      });

      await test.step("パレット開中は j が無効・Escape はパレットを閉じるだけ", async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await page.keyboard.press("j");
        await expect(activeRows).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("command-palette")).toBeHidden();
        await expect(page).toHaveURL(/\/tickets$/);
      });

      await test.step("o でアクティブ行の詳細が開く", async () => {
        await page.keyboard.press("j");
        await expect(anchorRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("o");
        await expect(page).toHaveURL(/\/tickets\/[^/]+$/);
        await expect(page.getByTestId("ticket-subject")).toContainText(anchor);
      });

      await test.step("詳細でもパレット開中の Escape は一覧へ戻らない", async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("command-palette")).toBeHidden();
        await expect(page).toHaveURL(/\/tickets\/[^/]+$/);
        // パレットが閉じた後の Escape は通常どおり一覧へ。
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/tickets$/);
      });
    },
  );
});
