import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { snap } from "../helpers/snap";

// Mock-first E2E for the kanban feature (spec: specs/kanban.md). The board is
// an agent-only view at /board that groups tickets into status columns and
// changes a ticket's status via drag-and-drop between columns. These verify UI
// plumbing only (columns → drag → persist, and the two failures), not content.
//
// The default project session is the seeded agent, which is what the board
// requires; the customer-forbidden case opts into the customer storageState.
test.describe("kanban board @feature-kanban", () => {
  // The smoke drags a ticket the test creates for itself over the API, not a
  // shared seed: E2E files share one database per run, so mutating a seed row's
  // status would race other specs that assert against that seed (アンカー型
  // アサーション規約 = 波及ゼロ). The created ticket starts in "open" and the
  // test moves it to in_progress, then verifies persistence on /tickets.
  // リトライごとに一意な subject にする: 共有DBでは前試行の作成分が残るため、
  // 固定 subject だとリトライで同名カードが複数になり strict mode violation になる
  const ownSubject = (testInfo: { testId: string; retry: number }) =>
    `Kanban smoke ${testInfo.testId} r${testInfo.retry}: elevator music too loud`;

  // Creates a ticket over the oRPC wire under the current (agent) session and
  // returns its id. oRPC RPCHandler wire: POST /api/rpc/tickets/create, body
  // {"json": input}, success body {"json": {id, ...}} (json 封筒を吸収する)。
  async function createTicket(request: APIRequestContext, subject: string): Promise<string> {
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
    "drags a ticket from Open to In progress and the new status persists @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者で /board を開き、テスト内で作成した専用チケットを Open 列から In progress 列へドラッグ&ドロップして列移動を確認し、/tickets 一覧でも当該チケットの status が in_progress に永続していることを検証する主経路",
      },
    },
    async ({ page, request }, testInfo) => {
      const subject = ownSubject(testInfo);
      let ticketId = "";
      await test.step("create a board-owned ticket over the API", async () => {
        ticketId = await createTicket(request, subject);
      });

      await test.step("open the board as an agent", async () => {
        await page.goto("/board");
        await expect(page.getByTestId("kanban-column-open")).toBeVisible();
        await expect(page.getByTestId("kanban-column-in_progress")).toBeVisible();
        await expect(page.getByTestId("kanban-column-resolved")).toBeVisible();
        await snap(page, testInfo, "ボード表示");
      });

      const ownCard = page
        .getByTestId("kanban-column-open")
        .getByTestId("kanban-card")
        .filter({ hasText: subject });
      const targetColumn = page.getByTestId("kanban-column-in_progress");

      await test.step("the created ticket starts in the Open column", async () => {
        await expect(ownCard).toBeVisible();
        await snap(page, testInfo, "ドラッグ前");
      });

      await test.step("drag the card into the In progress column", async () => {
        await page.dragAndDrop(
          `[data-testid="kanban-column-open"] [data-testid="kanban-card"]:has-text("${subject}")`,
          `[data-testid="kanban-column-in_progress"]`,
        );
        // 列移動が確定する: 対象カードが in_progress 列に現れ、open 列からは消える。
        await expect(
          targetColumn.getByTestId("kanban-card").filter({ hasText: subject }),
        ).toBeVisible();
        await expect(ownCard).toHaveCount(0);
        await expect(page.getByTestId("board-error")).toBeHidden();
        await snap(page, testInfo, "ドラッグ後");
      });

      await test.step("the new status persists on the tickets list", async () => {
        await page.goto(`/tickets/${ticketId}`);
        // 詳細画面の status バッジが in_progress を示す(永続の確認)。
        await expect(page.getByTestId("status-badge")).toContainText(/in progress/i);
        await snap(page, testInfo, "永続確認");
      });

      // Structural assertion: the three-column board shell — roles and order
      // only, survives copy and layout changes. Final state re-loaded so the
      // moved card sits under In progress.
      await page.goto("/board");
      await expect(page.getByTestId("kanban-board")).toMatchAriaSnapshot(`
      - list:
        - listitem
        - listitem
        - listitem
    `);
    },
  );

  test(
    "shows board-error and keeps the card in place when setStatus fails",
    {
      annotation: {
        type: "description",
        description:
          "setStatus のRPCが500を返すとき、ドラッグしたカードが元の Open 列に留まり board-error が表示されることを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      const subject = `Kanban failure ${testInfo.testId} r${testInfo.retry}: coffee machine offline`;
      await test.step("create a board-owned ticket over the API", async () => {
        await createTicket(request, subject);
      });

      await test.step("fail every setStatus call at the network layer", async () => {
        await page.route("**/api/rpc/tickets/setStatus", (route) =>
          route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "boom" } }),
          }),
        );
      });

      const openCard = page
        .getByTestId("kanban-column-open")
        .getByTestId("kanban-card")
        .filter({ hasText: subject });

      await test.step("open the board and locate the card in Open", async () => {
        await page.goto("/board");
        await expect(openCard).toBeVisible();
        await snap(page, testInfo, "ドラッグ前");
      });

      await test.step("drag the card and see the error, card stays put", async () => {
        await page.dragAndDrop(
          `[data-testid="kanban-column-open"] [data-testid="kanban-card"]:has-text("${subject}")`,
          `[data-testid="kanban-column-in_progress"]`,
        );
        await expect(page.getByTestId("board-error")).toBeVisible();
        // 失敗時はカードが元の open 列に残り、in_progress へは移らない。
        await expect(openCard).toBeVisible();
        await expect(
          page
            .getByTestId("kanban-column-in_progress")
            .getByTestId("kanban-card")
            .filter({ hasText: subject }),
        ).toHaveCount(0);
        await snap(page, testInfo, "失敗後");
      });
    },
  );

  // The board is agent-only, so a customer must land on the dedicated forbidden
  // panel (ticket-forbidden と同型), not the columns. This case opts out of the
  // project default (agent) into the seeded customer session; a nested describe
  // scopes the storageState override to this one test (path mirrors
  // auth.setup.ts's output, e2e/.auth/<role>.json).
  test.describe("as a customer", () => {
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "a customer visiting /board directly sees the forbidden panel",
      {
        annotation: {
          type: "description",
          description:
            "customer セッションで /board へ直アクセスしたとき、board-forbidden(担当者専用ビュー)が表示されカンバン列が出ないことを検証",
        },
      },
      async ({ page }, testInfo) => {
        await test.step("navigate directly to the board as a customer", async () => {
          await page.goto("/board");
        });

        await test.step("see the forbidden panel, not the columns", async () => {
          await expect(page.getByTestId("board-forbidden")).toBeVisible();
          // 反証固定(@pinned 相当): Board ナビリンクは agent 専用 — customer には出ない
          await expect(page.getByTestId("nav-board")).toHaveCount(0);
          await expect(page.getByTestId("kanban-column-open")).toHaveCount(0);
          await snap(page, testInfo, "アクセス禁止");
        });
      },
    );
  });
});
