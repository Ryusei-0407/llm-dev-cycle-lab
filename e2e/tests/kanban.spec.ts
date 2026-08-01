import { expect, test } from "../fixtures";
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

  // Isolate the board from realtime churn. The board is agent-wide, so it lists
  // EVERY ticket in the shared E2E database and its list query is invalidated by
  // every realtime ticket event — including creates from other specs running in
  // parallel. Each such event refetches and re-orders the columns (newest first),
  // shifting cards under the pointer; page.dragAndDrop resolves the source, then
  // a re-order between its hover and mousedown makes it grab a neighbouring card
  // — occasionally another spec's ticket, which then gets moved. That is the
  // kanban D&D flake. These tests verify drag→setStatus→persist, not realtime
  // (ws-realtime.spec covers that), so mock the socket to deliver no events and
  // keep the board still for the duration of the drag. The app treats the socket
  // as a progressive enhancement, so a silent socket changes nothing else.
  test.beforeEach(async ({ page }) => {
    await page.routeWebSocket(/\/api\/ws$/, () => {
      // Intercept without connectToServer(): the board's socket "opens" against
      // this mock and simply never receives an invalidation event.
    });
  });

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
      await test.step("ボード検証用のチケットをAPIで作成する", async () => {
        ticketId = await createTicket(request, subject);
      });

      await test.step("担当者としてボードを開く", async () => {
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

      await test.step("作成したチケットが Open 列にあることを確認する", async () => {
        await expect(ownCard).toBeVisible();
        await snap(page, testInfo, "ドラッグ前");
      });

      await test.step("カードを In progress 列へドラッグする", async () => {
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

      await test.step("新しいステータスが永続していることを確認する", async () => {
        await page.goto(`/tickets/${ticketId}`);
        // agent の詳細はヘッダの status バッジではなくプロパティパネルの
        // セレクトが状態を持つ(specs/detail-panel.md)。選択値で永続を確認。
        await expect(page.getByTestId("ticket-status-select")).toHaveValue("in_progress");
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
      await test.step("ボード検証用のチケットをAPIで作成する", async () => {
        await createTicket(request, subject);
      });

      await test.step("ネットワーク層で setStatus を全て失敗させる", async () => {
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

      await test.step("ボードを開き Open 列のカードを確認する", async () => {
        await page.goto("/board");
        await expect(openCard).toBeVisible();
        await snap(page, testInfo, "ドラッグ前");
      });

      await test.step("カードをドラッグしてエラー表示とカードが動かないことを確認する", async () => {
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
        await test.step("顧客としてボードへ直接アクセスする", async () => {
          await page.goto("/board");
        });

        await test.step("列ではなく閲覧不可パネルが出ることを確認する", async () => {
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
