import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the set-priority feature (spec: specs/set-priority.md E2E観点). The
// detail panel's priority row becomes editable for agents, mirroring the existing
// setStatus / setAssignee plumbing. Runs against the real oRPC routes over the
// postgres seed — the chromium project is authenticated as the seeded agent; the
// customer describe opts into the seeded customer session. These verify UI
// plumbing only (priority select → thread event → list follows, and the customer
// read-only + authz adaptation), not content.
//
// Shared-DB discipline (他E2Eファイルと同じDBを1ランで共有する): the agent smoke
// mutates priority, so it creates its own ticket via the New ticket form (which
// creates at medium — spec) rather than touching a shared seed row. The customer
// case only reads / probes authz, so it uses a seeded customer-owned ticket.
test.describe("set-priority over oRPC @feature-set-priority", () => {
  test(
    "agent changes priority from the properties panel and the thread + list follow @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が New ticket で自作チケット(medium で作られる)を作成し詳細を開き、右パネルの priority-select で high に変更するとスレッドに『優先度: medium → high』イベントが現れパネル表示も追従し、一覧に戻ると当該行の優先度表示が High になるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      // 共有DBに並走 create が乗るため、subject はラン内で一意化してアンカーの
      // 多重マッチを避ける(部分一致 hasText は類似文字列に多重マッチするという
      // 前サイクルの教訓)。
      const subject = `Set-priority smoke ${Date.now()}`;

      await test.step("担当者として自前のチケットを作成する(medium)", async () => {
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

      await test.step("プロパティパネルに priority-select が見えることを確認する", async () => {
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        // 作成直後は medium。セレクトが初期値を反映していることを併せて確認する。
        await expect(panel.getByTestId("priority-select")).toBeVisible();
        await expect(panel.getByTestId("priority-select")).toHaveValue("medium");
        await snap(page, testInfo, "プロパティパネル");
      });

      await test.step("パネルの priority-select で high に変更する", async () => {
        await page
          .getByTestId("ticket-properties")
          .getByTestId("priority-select")
          .selectOption("high");
      });

      await test.step("スレッドに優先度変更イベントが現れパネル表示も追従することを確認する", async () => {
        // イベント文言は spec の完全一致形式(優先度: {from} → {to}、生値)。
        await expect(
          page.getByTestId("ticket-event").filter({ hasText: "優先度: medium → high" }),
        ).toBeVisible();
        // パネルの priority-select が新しい値を反映していること(表示の追従)。
        await expect(
          page.getByTestId("ticket-properties").getByTestId("priority-select"),
        ).toHaveValue("high");
        await snap(page, testInfo, "優先度変更後");
      });

      await test.step("最終状態のプロパティパネル構造を確認する", async () => {
        // aria snapshot は locator 不在でも通りうるため、まずパネル可視を確認する。
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        // 構造的アサーション: role と順序のみ(値・文言は上のステップで固定済み)。
        // 状態(combobox)・優先度(combobox)・担当者(combobox)の3セレクトの骨格を固定する。
        await expect(panel).toMatchAriaSnapshot(`
          - complementary:
            - combobox
            - combobox
            - combobox
        `);
      });

      await test.step("一覧に戻ると当該行の優先度表示が High になる", async () => {
        await page.getByTestId("ticket-breadcrumb").getByRole("link", { name: "Tickets" }).click();
        await expect(page).toHaveURL(/\/tickets$/);
        // subject で一意に絞った当該行の優先度表示(capitalize)が High であること。
        const row = page.getByTestId("ticket-row").filter({ hasText: subject });
        await expect(row).toBeVisible();
        await expect(row).toContainText("High");
        await snap(page, testInfo, "一覧に復帰");
      });
    },
  );
});

// The customer read-only + authz adaptation opts into the seeded customer
// storageState (customer-portal.spec.ts の流儀): a separate describe because
// storageState is per-describe. Same @feature-set-priority tag so the media/
// scoping maps it to the same feature. Read/probe path — no shared-seed mutation
// (the direct setPriority POST is expected to be rejected, so it never writes).
test.describe("set-priority (customer) over oRPC @feature-set-priority", () => {
  test.use({ storageState: "e2e/.auth/customer.json" });

  test(
    "customer has no priority select and a direct setPriority POST is FORBIDDEN",
    {
      annotation: {
        type: "description",
        description:
          "顧客セッションで自分のシードチケット詳細を開くと priority-select が存在せず優先度はテキスト表示のみであること、さらに /api/rpc/tickets/setPriority を直接 POST すると HTTP 403(FORBIDDEN)で拒否されることを検証(setPriority は agent 専用)",
      },
    },
    async ({ page, request }, testInfo) => {
      // customer 所有のシード行(ticket-model シード)。detail-panel の customer
      // ケースと同じアンカーを使う。
      const subject = "Cannot login to dashboard";
      const CUSTOMER_TICKET = "00000000-0000-7000-8000-000000000001";

      await test.step("顧客として自分のシードチケット詳細を開く", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await page.getByTestId("ticket-link").filter({ hasText: subject }).click();
        await expect(page.getByTestId("ticket-subject")).toHaveText(subject);
        await snap(page, testInfo, "顧客の詳細表示");
      });

      await test.step("priority-select が存在せず優先度はテキスト表示のみであることを確認する", async () => {
        const panel = page.getByTestId("ticket-properties");
        await expect(panel).toBeVisible();
        await expect(panel.getByTestId("priority-select")).toHaveCount(0);
        // 表示のみ: 優先度テキスト(capitalize)がパネルに出ていること。
        // シードの Cannot login は high(triage.spec の High フィルタで残る行)。
        await expect(panel).toContainText("High");
        await snap(page, testInfo, "priority-select 不在");
      });

      await test.step("setPriority を直接 POST すると 403 FORBIDDEN で拒否される", async () => {
        const res = await request.post("/api/rpc/tickets/setPriority", {
          data: { json: { id: CUSTOMER_TICKET, priority: "low" } },
        });
        expect(res.status()).toBe(403);
        const body = (await res.json()) as { json?: { code?: string }; code?: string };
        const code = body.json?.code ?? body.code;
        expect(code).toBe("FORBIDDEN");
        await snap(page, testInfo, "直POST 403");
      });
    },
  );
});
