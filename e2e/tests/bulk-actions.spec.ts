import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the bulk-actions feature (spec: specs/bulk-actions.md E2E観点). The
// /tickets list gains a per-row select checkbox (agent only) and a bulk action
// bar that applies status / priority / assignee changes to the selection over
// tickets.bulkUpdate. Runs against the real oRPC routes over the postgres seed;
// the chromium project defaults to the seeded agent session (playwright.config.
// ts), and the customer describe opts into the seeded customer session. These
// verify UI plumbing only (select → bulk bar → apply → list follows, the error
// handling, and the customer role gate), not content.
//
// Shared-DB discipline (他E2Eファイルと同じDBを1ランで共有する): the smoke flow
// mutates status, so it creates its own tickets via the API rather than touching
// shared seed rows. subject はラン内で一意化してアンカーの多重マッチを避ける
// (部分一致 hasText は類似文字列に多重マッチするという前サイクルの教訓)。

// Creates an agent-owned ticket over the oRPC wire and returns its id. The
// chromium project is already the agent session, so request inherits that
// cookie. oRPC wire: POST /api/rpc/tickets/create, body {"json": input}.
async function createOwnTicket(request: APIRequestContext, subject: string): Promise<string> {
  const res = await request.post("/api/rpc/tickets/create", {
    data: { json: { subject, priority: "medium" } },
  });
  expect(res.ok(), `create expected 2xx, got ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { json?: { id?: string }; id?: string };
  const id = body.json?.id ?? body.id;
  expect(id, "created ticket id").toBeTruthy();
  return id!;
}

test.describe("bulk-actions over oRPC @feature-bulk-actions", () => {
  test(
    "agent selects two tickets and bulk-sets status to In progress @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が自作した2件のチケットを一覧のチェックボックスで選択し、一括アクションバーの status セレクトで In progress を選んで適用すると、両行の StatusBadge が In progress になり選択が解除されバーが消えるまでの主経路を検証",
      },
    },
    async ({ page, request }, testInfo) => {
      const stamp = Date.now();
      const subjectA = `Bulk smoke A ${stamp}`;
      const subjectB = `Bulk smoke B ${stamp}`;

      await test.step("一括対象の2件をAPIで作成する(open で作られる)", async () => {
        await createOwnTicket(request, subjectA);
        await createOwnTicket(request, subjectB);
      });

      await test.step("担当者として一覧を開き2件が見えることを確認する", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").filter({ hasText: subjectA })).toBeVisible();
        await expect(page.getByTestId("ticket-row").filter({ hasText: subjectB })).toBeVisible();
        await snap(page, testInfo, "作成後の一覧");
      });

      await test.step("2件の行のチェックボックスを選択する", async () => {
        // 行を subject で一意に絞り、その行内の select チェックボックスを押す。
        // クリックしても行の詳細 Link には遷移しないこと(URL が /tickets のまま)。
        await page
          .getByTestId("ticket-row")
          .filter({ hasText: subjectA })
          .getByTestId("ticket-select")
          .click();
        await page
          .getByTestId("ticket-row")
          .filter({ hasText: subjectB })
          .getByTestId("ticket-select")
          .click();
        await expect(page).toHaveURL(/\/tickets$/);
        await snap(page, testInfo, "2件選択");
      });

      await test.step("一括アクションバーが選択件数2で現れることを確認する", async () => {
        const bar = page.getByTestId("bulk-bar");
        await expect(bar).toBeVisible();
        await expect(bar.getByTestId("bulk-count")).toContainText("2");
        await snap(page, testInfo, "一括バー表示");
      });

      await test.step("status セレクトで In progress を選び適用する", async () => {
        await page.getByTestId("bulk-status-select").selectOption("in_progress");
        await page.getByTestId("bulk-apply").click();
      });

      await test.step("両行のバッジが In progress・選択解除・バー消滅を確認する", async () => {
        const rowA = page.getByTestId("ticket-row").filter({ hasText: subjectA });
        const rowB = page.getByTestId("ticket-row").filter({ hasText: subjectB });
        await expect(rowA.getByTestId("ticket-status")).toContainText("In progress");
        await expect(rowB.getByTestId("ticket-status")).toContainText("In progress");
        // 適用成功で選択解除 → バー消滅。
        await expect(page.getByTestId("bulk-bar")).toBeHidden();
        await snap(page, testInfo, "一括適用後");
      });

      // Structural assertion: the list shell (list of rows) — roles/order only.
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
        - list
      `);
    },
  );

  test(
    "a failed bulkUpdate shows an error and keeps the selection",
    {
      annotation: {
        type: "description",
        description:
          "bulkUpdate が 500 を返すよう page.route で固定した状態で選択2件に適用すると、bulk-error(role=alert)が表示され、行のバッジは据え置き・選択状態(bulk-bar)が維持されリトライ可能であることを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      const stamp = Date.now();
      const subjectA = `Bulk fail A ${stamp}`;
      const subjectB = `Bulk fail B ${stamp}`;

      await test.step("一括対象の2件をAPIで作成する", async () => {
        await createOwnTicket(request, subjectA);
        await createOwnTicket(request, subjectB);
      });

      await test.step("bulkUpdate を 500 に固定する", async () => {
        // モックレーン: bulkUpdate の POST だけを 500 に落とす(他の RPC は素通し)。
        await page.route("**/api/rpc/tickets/bulkUpdate", (route) =>
          route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ json: { code: "INTERNAL_SERVER_ERROR" } }),
          }),
        );
      });

      await test.step("担当者として一覧を開き2件を選択する", async () => {
        await page.goto("/tickets");
        await page
          .getByTestId("ticket-row")
          .filter({ hasText: subjectA })
          .getByTestId("ticket-select")
          .click();
        await page
          .getByTestId("ticket-row")
          .filter({ hasText: subjectB })
          .getByTestId("ticket-select")
          .click();
        await expect(page.getByTestId("bulk-bar")).toBeVisible();
        await snap(page, testInfo, "2件選択");
      });

      await test.step("status を選び適用する(500 が返る)", async () => {
        await page.getByTestId("bulk-status-select").selectOption("resolved");
        await page.getByTestId("bulk-apply").click();
      });

      await test.step("エラー表示・バッジ据え置き・選択維持を確認する", async () => {
        const error = page.getByTestId("bulk-error");
        await expect(error).toBeVisible();
        await expect(error).toHaveText("一括更新に失敗しました。");
        // role="alert" であること(spec): testid と role の両面で不在なら落ちる。
        await expect(
          page.getByRole("alert").filter({ hasText: "一括更新に失敗しました。" }),
        ).toBeVisible();
        // 行のバッジは Resolved になっていない(適用されていない)。
        const rowA = page.getByTestId("ticket-row").filter({ hasText: subjectA });
        await expect(rowA.getByTestId("ticket-status")).not.toContainText("Resolved");
        // 選択は維持され、バーは出たまま(リトライ可能)。
        await expect(page.getByTestId("bulk-bar")).toBeVisible();
        await expect(page.getByTestId("bulk-count")).toContainText("2");
        await snap(page, testInfo, "エラー後も選択維持");
      });
    },
  );
});

// The customer role gate opts into the seeded customer storageState
// (customer-portal.spec.ts の流儀): a separate describe because storageState is
// per-describe. Same @feature-bulk-actions tag so the media/scoping maps it to
// the same feature. Read/probe path — the direct bulkUpdate POST is expected to
// be rejected, so it never writes to the shared seed.
test.describe("bulk-actions (customer) over oRPC @feature-bulk-actions", () => {
  test.use({ storageState: "e2e/.auth/customer.json" });

  test(
    "customer sees no select checkboxes and a direct bulkUpdate POST is FORBIDDEN",
    {
      annotation: {
        type: "description",
        description:
          "顧客セッションで /tickets を開くと選択チェックボックス(ticket-select)が1件も存在せず、さらに /api/rpc/tickets/bulkUpdate を直接 POST すると HTTP 403(FORBIDDEN)で拒否されることを検証(選択 UI は agent 専用)",
      },
    },
    async ({ page, request }, testInfo) => {
      const CUSTOMER_TICKET = "00000000-0000-7000-8000-000000000001"; // customer 所有のシード行

      await test.step("顧客としてチケット一覧を開く", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "顧客の一覧表示");
      });

      await test.step("選択チェックボックスが1件も無いことを確認する", async () => {
        await expect(page.getByTestId("ticket-select")).toHaveCount(0);
        // 一括バーも当然出ない(選択できないため)。
        await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
        await snap(page, testInfo, "選択UI不在");
      });

      await test.step("bulkUpdate を直接 POST すると 403 FORBIDDEN で拒否される", async () => {
        const res = await request.post("/api/rpc/tickets/bulkUpdate", {
          data: { json: { ids: [CUSTOMER_TICKET], patch: { status: "resolved" } } },
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
