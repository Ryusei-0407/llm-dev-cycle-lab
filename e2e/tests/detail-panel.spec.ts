import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the detail-panel feature (spec: specs/detail-panel.md). Phase-3 recut
// of /tickets/$id into a two-pane layout: a center thread column plus a right
// `ticket-properties` aside carrying the status / assignee / label controls that
// used to live in the header's control box. The API is unchanged (specs は API
// 変更なしと明記), so these run against the real oRPC routes over the postgres
// seed — the chromium project is authenticated as the seeded agent; the
// customer describe opts into the seeded customer session. They verify UI
// plumbing only (properties panel visible → status change from the panel →
// thread event + panel follows → breadcrumb 戻り, and the customer read-only
// adaptation), not content. Thread-row width unification is VRT's remit
// (spec 末尾), asserted nowhere here.
//
// Shared-DB discipline (他E2Eファイルと同じDBを1ランで共有する): the agent smoke
// mutates status, so it creates its own ticket via the New ticket form rather
// than touching a shared seed row. The customer case only reads, so it uses a
// seeded customer-owned ticket.
test.describe("detail-panel over oRPC @feature-detail-panel", () => {
  test(
    "agent changes status from the properties panel and the thread follows @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が自作チケットの詳細を開き、右の ticket-properties パネル(状態/担当者/ラベル/ticket-requester=自分のメール)を確認し、パネルの状態セレクトで in_progress に変更するとスレッドに『状態: open → in_progress』イベントが現れパネル表示も追従し、breadcrumb の Tickets リンクで一覧に戻れるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      // 共有DBに並走 create が乗るため、subject はラン内で一意化してアンカーの
      // 多重マッチを避ける(部分一致 hasText は類似文字列に多重マッチするという
      // 前サイクルの教訓)。
      const subject = `Detail-panel smoke ${Date.now()}`;

      await test.step("担当者として自前のチケットを作成する", async () => {
        await page.goto("/tickets");
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").fill(subject);
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await snap(page, testInfo, "作成後の一覧");
      });

      await test.step("作成したチケットの詳細を開く", async () => {
        await page.getByTestId("ticket-link").filter({ hasText: subject }).click();
        // subject は exact でアンカーする(類似 subject への多重マッチ回避)。
        await expect(page.getByTestId("ticket-subject")).toHaveText(subject);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("プロパティパネルに各コントロールと依頼者が見えることを確認する", async () => {
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        // aria snapshot は locator 不在でも通りうるため、各 testid に toBeVisible を併記する。
        await expect(panel.getByTestId("ticket-status-select")).toBeVisible();
        await expect(panel.getByTestId("assignee-select")).toBeVisible();
        // ラベルトグル群はカタログ全件。存在の下限として1件以上を要求する。
        await expect(panel.getByTestId(/^label-toggle-/).first()).toBeVisible();
        // 依頼者は作成者=agent 自身のメール。exact でアンカーする。
        await expect(panel.getByTestId("ticket-requester")).toHaveText("agent@example.com");
        await snap(page, testInfo, "プロパティパネル");
      });

      await test.step("パネルの状態セレクトで in_progress に変更する", async () => {
        await page
          .getByTestId("ticket-properties")
          .getByTestId("ticket-status-select")
          .selectOption("in_progress");
      });

      await test.step("スレッドに状態変更イベントが現れパネル表示も追従することを確認する", async () => {
        // イベント文言は spec の完全一致形式(状態: {from} → {to}、open/in_progress の生値)。
        await expect(
          page.getByTestId("ticket-event").filter({ hasText: "状態: open → in_progress" }),
        ).toBeVisible();
        // パネルの状態セレクトが新しい値を反映していること(表示の追従)。
        await expect(
          page.getByTestId("ticket-properties").getByTestId("ticket-status-select"),
        ).toHaveValue("in_progress");
        await snap(page, testInfo, "状態変更後");
      });

      await test.step("最終状態のプロパティパネル構造を確認する", async () => {
        // aria snapshot は locator 不在でも通りうるため、まずパネル可視を確認する。
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        // 構造的アサーション: role と順序のみ(値・文言は上のステップで固定済み)。
        // 状態(combobox)・担当者(combobox)を含む閲覧/操作行の骨格を固定する。
        await expect(panel).toMatchAriaSnapshot(`
          - complementary:
            - combobox
            - combobox
        `);
      });

      await test.step("breadcrumb の Tickets リンクで一覧に戻る", async () => {
        await page.getByTestId("ticket-breadcrumb").getByRole("link", { name: "Tickets" }).click();
        await expect(page).toHaveURL(/\/tickets$/);
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "一覧に復帰");
      });
    },
  );
});

// The customer read-only adaptation opts into the seeded customer storageState
// (customer-portal.spec.ts の流儀): a separate describe because storageState is
// per-describe. Same @feature-detail-panel tag so the media/scoping maps it to
// the same feature. Read-only path — no shared-seed mutation.
test.describe("detail-panel (customer) over oRPC @feature-detail-panel", () => {
  test.use({ storageState: "e2e/.auth/customer.json" });

  test(
    "customer sees a read-only properties panel with no agent controls",
    {
      annotation: {
        type: "description",
        description:
          "顧客セッションで自分のシードチケット詳細を開くと ticket-properties パネルが見える一方、状態セレクト・担当者セレクト・ラベルトグルが存在せず、状態バッジ・ticket-requester・付与済みラベルチップ(ticket-label)が閲覧表示されることを検証",
      },
    },
    async ({ page }, testInfo) => {
      // 付与済みラベルのチップ表示を検証するため、ラベルを持つシード行を選ぶ。
      // "Cannot login to dashboard" は auth ラベル付き(ticket-model シード)で
      // customer 所有(customer-portal.spec の前提と同じく seed は全て customer 所有)。
      const subject = "Cannot login to dashboard";

      await test.step("顧客としてラベル付きのシードチケットを開く", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await page.getByTestId("ticket-link").filter({ hasText: subject }).click();
        await expect(page.getByTestId("ticket-subject")).toHaveText(subject);
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("プロパティパネルが見え、閲覧表示要素が揃うことを確認する", async () => {
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        // 閲覧表示: 状態バッジ・依頼者・付与済みラベルチップ。
        await expect(panel.getByTestId("status-badge")).toBeVisible();
        await expect(panel.getByTestId("ticket-requester")).toBeVisible();
        await expect(
          panel.getByTestId("ticket-labels").getByTestId("ticket-label").first(),
        ).toBeVisible();
        await snap(page, testInfo, "閲覧パネル");
      });

      await test.step("担当者専用コントロールが存在しないことを確認する", async () => {
        const panel = page.getByTestId("ticket-properties");
        await expect(panel.getByTestId("ticket-status-select")).toHaveCount(0);
        await expect(panel.getByTestId("assignee-select")).toHaveCount(0);
        await expect(panel.getByTestId(/^label-toggle-/)).toHaveCount(0);
        await snap(page, testInfo, "コントロール不在");
      });
    },
  );
});
