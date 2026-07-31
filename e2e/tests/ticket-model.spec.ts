import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";
import { apiLogin } from "../helpers/auth";
import { snap } from "../helpers/snap";

// E2E for ticket-model (spec: specs/ticket-model.md E2E観点). Runs against the
// real oRPC routes over the deterministic postgres seed. The chromium project
// defaults to the seeded agent session (playwright.config.ts), so the smoke and
// status-history flows drive the agent-only assignee select / label toggles;
// the authz case opts into the customer session. These verify UI plumbing only
// (number/labels/assignee display, assignee & label edits, the merged event
// thread, and role-gated controls), not content. Shared-DB anchor rules apply:
// no absolute count assertions on seed rows, no seed mutation — the status flow
// uses a ticket the test creates for itself (POLICY.md 共有DBアンカー規約).

test.describe("ticket-model over oRPC @feature-ticket-model", () => {
  test(
    "agent sees number/label/assignee, reassigns, and toggles a label @smoke",
    {
      annotation: {
        type: "description",
        description:
          "agent で /tickets を開き Billing question 行に SUP-2・billing ラベル・担当者 agent が見えること、詳細で担当者を未割り当てに変更するとイベント行が現れ、api ラベルを付けるとラベル表示とイベント行が更新されるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("一覧で番号・ラベル・担当者を確認する", async () => {
        await page.goto("/tickets");
        const row = page.getByTestId("ticket-row").filter({ hasText: "Billing question" });
        await expect(row.getByTestId("ticket-number")).toHaveText("SUP-2");
        await expect(row.getByTestId("ticket-label").filter({ hasText: "billing" })).toBeVisible();
        await expect(row.getByTestId("ticket-assignee")).toHaveText("agent");
        await snap(page, testInfo, "一覧の番号ラベル担当者");
      });

      await test.step("詳細を開く", async () => {
        await page.getByTestId("ticket-link").filter({ hasText: "Billing question" }).click();
        await expect(page.getByTestId("ticket-number")).toHaveText("SUP-2");
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("担当者を未割り当てに変更しイベント行を確認する", async () => {
        await page.getByTestId("assignee-select").selectOption("");
        await expect(
          page
            .getByTestId("ticket-event")
            .filter({ hasText: "担当者: agent@example.com → 未割り当て" }),
        ).toBeVisible();
        await snap(page, testInfo, "担当者変更後");
      });

      await test.step("api ラベルを付与しラベル表示とイベント行を確認する", async () => {
        await page.getByTestId("label-toggle-api").click();
        await expect(
          page.getByTestId("ticket-labels").getByTestId("ticket-label").filter({ hasText: "api" }),
        ).toBeVisible();
        await expect(
          page.getByTestId("ticket-event").filter({ hasText: "ラベル: api, billing" }),
        ).toBeVisible();
        await snap(page, testInfo, "ラベル付与後");
      });

      // Structural assertion: the detail thread shell (subject, merged
      // message/event list, agent controls) — roles and order only.
      await expect(page.getByTestId("message-thread")).toMatchAriaSnapshot(`
        - list
      `);
    },
  );

  test(
    "a status change appears in the detail event thread",
    {
      annotation: {
        type: "description",
        description:
          "他テストと競合しないチケットを新規作成し status を in_progress→resolved に変更すると、詳細のイベント行『状態: in_progress → resolved』が表示されることを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      let ticketId = "";
      await test.step("履歴検証用のチケットをAPIで作成する", async () => {
        ticketId = await createAgentTicket(request, "Status history: label printer offline");
      });

      await test.step("詳細を開いて status を in_progress にする", async () => {
        await page.goto(`/tickets/${ticketId}`);
        await page.getByTestId("ticket-status-select").selectOption("in_progress");
        await expect(
          page.getByTestId("ticket-event").filter({ hasText: "状態: open → in_progress" }),
        ).toBeVisible();
        await snap(page, testInfo, "in_progress へ");
      });

      await test.step("status を resolved にしてイベント行を確認する", async () => {
        await page.getByTestId("ticket-status-select").selectOption("resolved");
        await expect(
          page.getByTestId("ticket-event").filter({ hasText: "状態: in_progress → resolved" }),
        ).toBeVisible();
        await snap(page, testInfo, "resolved へ");
      });
    },
  );

  // Opt into the seeded customer session for the authz case only (the smoke and
  // status flows need the default agent session). Nested describe so test.use's
  // storageState swap is scoped to this one test; path mirrors auth.setup.ts's
  // output (e2e/.auth/<role>.json), as customer-portal.spec.ts does.
  test.describe("customer view @feature-ticket-model", () => {
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "customer sees the number and events but no assignee/label controls",
      {
        annotation: {
          type: "description",
          description:
            "customer が自分のチケット詳細を開くと番号とイベント閲覧はできる一方、assignee-select と label-toggle が存在しないことを検証(編集操作は agent 専用)",
        },
      },
      async ({ page, request }, testInfo) => {
        let ticketId = "";
        await test.step("顧客所有のチケットをAPIで用意し agent が1度操作して履歴を作る", async () => {
          // customer 自身が作成 → agent が status を変更してイベントを1件作る。
          // これで customer 側でも「番号・イベントは見える」ことを検証できる。
          // 注意: request コンテキストは apiLogin でロールを切替えるが、page の
          // ブラウザコンテキストは test.use の customer storageState を保持する。
          ticketId = await createOwnTicket(request, "Customer view: printer smells like toast");
          await apiLogin(request, "agent");
          const res = await request.post("/api/rpc/tickets/setStatus", {
            data: { json: { id: ticketId, status: "in_progress" } },
          });
          expect(res.ok(), `setStatus expected 2xx, got ${res.status()}`).toBeTruthy();
        });

        await test.step("顧客として自分のチケット詳細を開く", async () => {
          await page.goto(`/tickets/${ticketId}`);
          await expect(page.getByTestId("ticket-number")).toBeVisible();
          await snap(page, testInfo, "顧客の詳細表示");
        });

        await test.step("番号とイベントは見え、編集コントロールは無いことを確認する", async () => {
          await expect(
            page.getByTestId("ticket-event").filter({ hasText: "状態: open → in_progress" }),
          ).toBeVisible();
          await expect(page.getByTestId("assignee-select")).toHaveCount(0);
          await expect(page.getByTestId("label-toggle-api")).toHaveCount(0);
          await snap(page, testInfo, "編集コントロールなし");
        });
      },
    );
  });
});

// Creates a ticket owned by the *agent* (requesterEmail = agent@example.com)
// over the oRPC wire, so the status-history flow has a deterministic target
// without mutating the shared seed (customer-portal.spec.ts の流儀)。The default
// chromium session is already the agent, but we log in explicitly so this helper
// is independent of any prior role swap in the same request context.
async function createAgentTicket(request: APIRequestContext, subject: string): Promise<string> {
  await apiLogin(request, "agent");
  const res = await request.post("/api/rpc/tickets/create", {
    data: { json: { subject, priority: "medium" } },
  });
  expect(res.ok(), `create expected 2xx, got ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { json?: { id?: string }; id?: string };
  const id = body.json?.id ?? body.id;
  expect(id, "created ticket id").toBeTruthy();
  return id!;
}

// Creates a ticket owned by the *customer* over the oRPC wire (customer session),
// so the authz case has a customer-owned target the customer may open.
async function createOwnTicket(request: APIRequestContext, subject: string): Promise<string> {
  await apiLogin(request, "customer");
  const res = await request.post("/api/rpc/tickets/create", {
    data: { json: { subject, priority: "low" } },
  });
  expect(res.ok(), `create expected 2xx, got ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { json?: { id?: string }; id?: string };
  const id = body.json?.id ?? body.id;
  expect(id, "created ticket id").toBeTruthy();
  return id!;
}
