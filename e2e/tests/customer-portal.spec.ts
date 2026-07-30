import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";
import { apiLogin } from "../helpers/auth";
import { snap } from "../helpers/snap";

// E2E for the customer-portal feature (spec: specs/customer-portal.md). Unlike
// every other chromium spec (which defaults to the seeded agent session), this
// describe opts into the seeded *customer* storageState so it exercises the
// role-adapted UI: no agent-only controls (status select, Generate draft) and
// the FORBIDDEN handling for another user's ticket. API authz is already
// implemented (specs/authz.md); these tests pin the UI adaptation on top of it.
// They verify plumbing only (list → detail → reply, and the two customer-side
// failures), not content. The customer sees only their own tickets because the
// API filters list() by requesterEmail, so the seed (all customer-owned) is the
// customer's whole list.
test.describe("customer-portal @feature-customer-portal", () => {
  // Opt out of the project default (agent) into the seeded customer session.
  // Path mirrors auth.setup.ts's output (e2e/.auth/<role>.json).
  test.use({ storageState: "e2e/.auth/customer.json" });

  // The smoke flow replies on a ticket the test creates for itself over the
  // API (as the customer session): replying on a shared seed would mutate the
  // thread other spec files assert against — E2E files share one database per
  // run, so every mutation must stay on test-owned rows.
  const OWN_SUBJECT = "Portal smoke: printer makes clicking noises";

  async function createOwnTicket(request: APIRequestContext, subject: string): Promise<string> {
    const res = await request.post("/api/rpc/tickets/create", {
      data: { json: { subject, priority: "low" } },
    });
    expect(res.ok(), `create expected 2xx, got ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as { json?: { id?: string }; id?: string };
    const id = body.json?.id ?? body.id;
    expect(id, "created ticket id").toBeTruthy();
    return id!;
  }

  // Creates a ticket owned by the *agent* (requesterEmail = agent@example.com)
  // over the oRPC wire, so the customer-side "someone else's ticket" cases have
  // a deterministic target without mutating the shared seed. Uses the API layer
  // directly (auth.ts の apiLogin 流儀): apiLogin swaps the request context's
  // session cookie to the agent, then create runs under that agent session.
  // oRPC RPCHandler wire: POST /api/rpc/tickets/create, body {"json": input},
  // success body {"json": {id, requesterEmail, ...}} (json 封筒を吸収する)。
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

  test(
    "customer sees only their tickets, no agent controls, and can reply @smoke",
    {
      annotation: {
        type: "description",
        description:
          "顧客セッションで /tickets を開くと担当者向けの status 変更 select が無く、自分のチケット詳細には Generate draft が無い状態で返信でき、スレッド末尾に自分の返信が追加されるまでの主経路を検証",
      },
    },
    async ({ page, request }, testInfo) => {
      await test.step("ポータル検証用のチケットをAPIで作成する", async () => {
        await createOwnTicket(request, OWN_SUBJECT);
      });

      await test.step("顧客としてチケット一覧を開く", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "一覧表示");
      });

      await test.step("担当者専用のステータス操作が無いことを確認する", async () => {
        // 担当者向け操作(status 変更)は customer には出さない。spec が名指しする
        // data-testid と、現状 UI の実体(role=combobox の select)の両面で不在を見る。
        await expect(page.getByTestId("ticket-status-select")).toHaveCount(0);
        await expect(page.getByRole("combobox", { name: /^Status for / })).toHaveCount(0);
        await snap(page, testInfo, "担当者操作なし");
      });

      await test.step("自分のチケットを開く", async () => {
        await page.getByTestId("ticket-link").filter({ hasText: OWN_SUBJECT }).click();
        await expect(page.getByTestId("ticket-subject")).toContainText(OWN_SUBJECT);
        await expect(page.getByTestId("ticket-forbidden")).toBeHidden();
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("詳細画面にドラフト生成(担当者専用)が無いことを確認する", async () => {
        await expect(page.getByTestId("generate-draft")).toHaveCount(0);
        await snap(page, testInfo, "ドラフト操作なし");
      });

      await test.step("自分のチケットに返信を投稿する", async () => {
        // 相対比較: シードの絶対件数ではなく「返信で1件増える」ことを見る。
        const before = await page.getByTestId("message-item").count();
        await page.getByLabel("Reply").fill("Thanks, I've tried again and it still fails.");
        await page.getByRole("button", { name: "Send reply" }).click();
        await expect(page.getByTestId("message-item")).toHaveCount(before + 1);
        await expect(page.getByTestId("message-item").last()).toContainText("still fails");
        await expect(page.getByLabel("Reply")).toHaveValue("");
        await expect(page.getByTestId("reply-error")).toBeHidden();
        await snap(page, testInfo, "返信後");
      });

      // Structural assertion: the customer thread shell (subject, message list,
      // reply control) — roles and order only, survives copy and layout changes.
      await expect(page.getByTestId("message-thread")).toMatchAriaSnapshot(`
      - list:
        - listitem
    `);
    },
  );

  test(
    "direct access to an agent's ticket shows the forbidden panel",
    {
      annotation: {
        type: "description",
        description:
          "agent が作成した他人のチケットへ customer が直URLでアクセスしたとき、API の FORBIDDEN を受けて ticket-forbidden(not-found とは別文言)が表示されることを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      let agentTicketId = "";
      await test.step("担当者所有のチケットをAPIで準備する", async () => {
        agentTicketId = await createAgentTicket(request, "Agent-only ticket (forbidden target)");
      });

      await test.step("担当者のチケットへ直接アクセスする", async () => {
        await page.goto(`/tickets/${agentTicketId}`);
      });

      await test.step("スレッドではなく閲覧不可パネルが出ることを確認する", async () => {
        await expect(page.getByTestId("ticket-forbidden")).toBeVisible();
        await expect(page.getByTestId("ticket-not-found")).toBeHidden();
        await expect(page.getByTestId("message-thread")).toBeHidden();
        await snap(page, testInfo, "アクセス禁止");
      });
    },
  );

  test(
    "an agent-created ticket never appears in the customer's list",
    {
      annotation: {
        type: "description",
        description:
          "agent が作成したチケットの subject が、customer の /tickets 一覧に混入しないことを検証(API の requesterEmail フィルタが UI に反映される)",
      },
    },
    async ({ page, request }, testInfo) => {
      const agentSubject = "Agent-only ticket (list-leak check)";
      await test.step("担当者所有のチケットをAPIで準備する", async () => {
        await createAgentTicket(request, agentSubject);
      });

      await test.step("顧客のチケット一覧を読み込む", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "一覧表示");
      });

      await test.step("担当者のチケットが一覧に無いことを確認する", async () => {
        await expect(page.getByTestId("ticket-link").filter({ hasText: agentSubject })).toHaveCount(
          0,
        );
        await snap(page, testInfo, "混入なし");
      });
    },
  );
});
