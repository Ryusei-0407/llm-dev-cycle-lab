import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the triage feature (spec: specs/triage.md E2E観点). The signed-in agent
// gains a "受信トレイ"(inbox)sidebar entry with a count badge and an /inbox
// route listing unassigned & unresolved tickets, plus a server-side filter bar
// on /tickets bound to URL search params. These verify plumbing only
// (作成 → 受信トレイ表示 → 割り当て → 消える / フィルタ絞り込み / customer 出し分け),
// not content — role と順序でアサートする。
//
// Lanes:
// - @smoke(実バックエンド・agent): New ticket で自作 → nav-inbox で受信トレイ →
//   自作行が見える(未割り当て)→ 詳細で自分に割り当て → 受信トレイに戻ると消える。
//   共有DBのため件数は具体数を見ず、自作 subject のアンカーと badge の存在で見る。
// - フィルタ(agent): /tickets の filter-priority / filter-label でシードのアンカー行が
//   出入りし、URL search param が反映され、filter-clear で復活することを見る。
// - customer(入れ子 describe でセッション切替): nav-inbox 不在・/inbox で inbox-forbidden・
//   /tickets の filter-status は使えることを見る。
test.describe("triage @feature-triage", () => {
  test(
    "agent triages an unassigned ticket from the inbox @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が New ticket で自作チケットを作成し、サイドバーの受信トレイ(nav-inbox)を開くと未割り当ての自作行が見え、詳細で assignee-select から自分に割り当てて受信トレイへ戻るとその行が消える(受信トレイ = 未割り当てかつ非 resolved)主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      // 自作 subject をアンカーにする(共有DBの並走 create/割り当てに影響されない)。
      const subject = `Triage smoke: monitor flickers ${Date.now()}`;

      await test.step("チケット一覧で自前チケットを作成する", async () => {
        await page.goto("/tickets");
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").fill(subject);
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await snap(page, testInfo, "自作チケット作成");
      });

      await test.step("サイドバーの受信トレイへ遷移する", async () => {
        const sidebar = page.getByTestId("app-sidebar");
        await expect(sidebar.getByTestId("nav-inbox")).toBeVisible();
        await sidebar.getByTestId("nav-inbox").click();
        await expect(page).toHaveURL(/\/inbox$/);
        await expect(page.getByRole("heading", { name: "受信トレイ" })).toBeVisible();
        // 未割り当ての自作チケットは受信トレイに現れる。件数バッジは存在まで見る
        // (共有DBのため具体数は見ない)。0件でないので badge は出ているはず。
        await expect(page.getByTestId("inbox-count")).toBeVisible();
        await snap(page, testInfo, "受信トレイ表示");
      });

      await test.step("受信トレイに自作行(未割り当て)が見える", async () => {
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await snap(page, testInfo, "自作行あり");
      });

      await test.step("行から詳細を開き自分に割り当てる", async () => {
        await page.getByTestId("ticket-link").filter({ hasText: subject }).click();
        await expect(page.getByTestId("ticket-subject")).toHaveText(subject);
        // assignee-select は native select。値は agent の email(setAssignee の
        // assigneeEmail 契約)。option 表示名には依存しない。
        await page
          .getByTestId("ticket-properties")
          .getByTestId("assignee-select")
          .selectOption("agent@example.com");
        await expect(
          page.getByTestId("ticket-properties").getByTestId("assignee-select"),
        ).toHaveValue("agent@example.com");
        await snap(page, testInfo, "自分に割り当て");
      });

      await test.step("受信トレイに戻ると割り当て済みの自作行が消える", async () => {
        await page.getByTestId("app-sidebar").getByTestId("nav-inbox").click();
        await expect(page).toHaveURL(/\/inbox$/);
        // 割り当て済みは受信トレイの条件(未割り当て)から外れるため消える。
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toHaveCount(0);
        await snap(page, testInfo, "割り当て後は消える");
      });

      // Structural assertion: 最終状態の app-sidebar が受信トレイリンクを含む骨格
      // (role と順序のみ)。aria snapshot は不在でも通りうるため上で toBeVisible 済み。
      // 受信トレイのアクセシブルネームはバッジ件数を含み得る(共有DBで並走
      // テストが未割り当てチケットを残すと「受信トレイ N」になる)。件数に
      // 依存しないよう正規表現で前方一致させる。
      await expect(page.getByTestId("app-sidebar")).toMatchAriaSnapshot(`
        - link /受信トレイ/
        - link "Tickets"
        - link "Board"
        - button "Sign out"
      `);
    },
  );

  test(
    "server-side filters narrow the ticket list and reflect in the URL",
    {
      annotation: {
        type: "description",
        description:
          "担当者が /tickets で filter-priority を High にするとシードの high 行(Cannot login)が残り medium 行(Billing)が消え、さらに filter-label を billing にすると両方消えて 0 行になり、filter-clear で両行が復活し、各操作が URL の search param に反映されることを検証(サーバサイドフィルタ)",
      },
    },
    async ({ page }, testInfo) => {
      // シードのアンカー行(共有DB前提でこの2行は他テストが消さない: 削除機能は無い)。
      // 既存 spec と同じ substring アンカー(seed 内でこの2文言は一意)。行テキストは
      // 番号プレフィクス等を含みうるため ^ アンカーは使わない(初期表示で誤って不一致になる)。
      const highRow = page
        .getByTestId("ticket-row")
        .filter({ hasText: "Cannot login to dashboard" });
      const mediumRow = page.getByTestId("ticket-row").filter({ hasText: "Billing question" });

      await test.step("チケット一覧を開き両アンカー行が見える", async () => {
        await page.goto("/tickets");
        await expect(highRow).toBeVisible();
        await expect(mediumRow).toBeVisible();
        await snap(page, testInfo, "フィルタ前");
      });

      await test.step("priority を High で絞り込む", async () => {
        await page.getByTestId("filter-priority").selectOption("high");
        await expect(highRow).toBeVisible();
        await expect(mediumRow).toHaveCount(0);
        await expect(page).toHaveURL(/priority=high/);
        await snap(page, testInfo, "High で絞り込み");
      });

      await test.step("さらに label を billing で絞り込むと 0 行になる", async () => {
        // High かつ billing のチケットはシードに無い(Cannot login は auth)。
        await page.getByTestId("filter-label").selectOption("billing");
        await expect(highRow).toHaveCount(0);
        await expect(mediumRow).toHaveCount(0);
        await expect(page).toHaveURL(/priority=high/);
        await expect(page).toHaveURL(/label=billing/);
        await snap(page, testInfo, "High+billing で 0 行");
      });

      await test.step("クリアで両アンカー行が復活する", async () => {
        await page.getByTestId("filter-clear").click();
        await expect(highRow).toBeVisible();
        await expect(mediumRow).toBeVisible();
        // 全解除後は search param が落ちる。
        await expect(page).not.toHaveURL(/priority=/);
        await expect(page).not.toHaveURL(/label=/);
        await snap(page, testInfo, "クリア後に復活");
      });
    },
  );

  test.describe("customer session", () => {
    // 顧客セッションに opt-in(project 既定は agent)。app-shell / customer-portal
    // spec と同じ storageState(setup 生成の e2e/.auth/customer.json)。
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "customer has no inbox nav, is forbidden at /inbox, but can use filters",
      {
        annotation: {
          type: "description",
          description:
            "顧客セッションでは app-sidebar に受信トレイ(nav-inbox)が無く、/inbox へ直接アクセスすると inbox-forbidden が表示され(リダイレクトしない)、一方で /tickets のフィルタバー(filter-status)は使えることを検証(受信トレイは agent 専用・フィルタは両ロール)",
        },
      },
      async ({ page }, testInfo) => {
        await test.step("サイドバーに受信トレイリンクが無いことを確認する", async () => {
          await page.goto("/tickets");
          const sidebar = page.getByTestId("app-sidebar");
          await expect(sidebar).toBeVisible();
          await expect(sidebar.getByTestId("nav-inbox")).toHaveCount(0);
          await snap(page, testInfo, "受信トレイリンクなし");
        });

        await test.step("/inbox 直アクセスで inbox-forbidden が出る", async () => {
          await page.goto("/inbox");
          await expect(page.getByTestId("inbox-forbidden")).toBeVisible();
          // リダイレクトしない(board-forbidden と同じ流儀)。
          await expect(page).toHaveURL(/\/inbox$/);
          await snap(page, testInfo, "inbox-forbidden");
        });

        await test.step("/tickets のフィルタバーは customer でも使える", async () => {
          await page.goto("/tickets");
          const statusFilter = page.getByTestId("filter-status");
          await expect(statusFilter).toBeVisible();
          await statusFilter.selectOption("open");
          await expect(page).toHaveURL(/status=open/);
          await snap(page, testInfo, "customer のフィルタ");
        });
      },
    );
  });
});
