import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { snap } from "../helpers/snap";

// E2E for the ws-realtime feature (spec: specs/ws-realtime.md). Ticket changes
// are pushed over /api/ws so open clients auto-update without a reload. These
// verify plumbing only (a change made elsewhere appears live; the app survives
// a blocked / dropped socket), not content.
//
// The smoke path is multi-source: page A (the default agent session) sits on
// /tickets while the `request` fixture — the same agent session — creates a
// ticket over the API. A reload-free appearance of that subject proves the
// WS-driven invalidation, not a route re-fetch. Every mutation stays on a
// test-owned subject so it never perturbs rows other spec files assert against
// (E2E files share one database per run).
test.describe("ws-realtime over WebSocket @feature-ws-realtime", () => {
  // oRPC RPCHandler wire: POST /api/rpc/tickets/create, body {"json": input},
  // success body {"json": {id, ...}}. request carries the project's agent
  // storageState, so this creates as the agent without driving any UI.
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
    "a ticket created elsewhere appears in an open list without reload @smoke",
    {
      annotation: {
        type: "description",
        description:
          "/tickets を開いたページが、別ソース(API)で作成された新チケットを reload なしで一覧に表示する(WebSocket 経由の自動更新)ことを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      const subject = `WS live: ${test.info().testId} tape drive rewinding`;

      await test.step("open the tickets list and wait for the live socket", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        // 自動更新の前提となる /api/ws 接続が確立するのを待つ。固定待ちは使わず、
        // WebSocket ハンドシェイクの成立をイベントで待つ(この接続が張れないと
        // このテストは「reload 無し反映」を検証できない)。
        await page.waitForEvent("websocket", {
          predicate: (ws) => ws.url().includes("/api/ws"),
        });
        await snap(page, testInfo, "初期表示");
      });

      await test.step("create a ticket from another source (API)", async () => {
        await createTicket(request, subject);
      });

      await test.step("the new ticket appears without a reload", async () => {
        // reload を呼ばない: WebSocket が invalidate を駆動して一覧が更新される
        // ことだけで、この行が現れる。
        await expect(page.getByTestId("ticket-row").filter({ hasText: subject })).toBeVisible();
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "自動反映後");
      });

      // Structural assertion: the just-arrived ticket leads the list, the three
      // seeds follow — roles and order only. Each subject is a router Link.
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
      - list:
        - listitem:
          - link /tape drive rewinding/
        - listitem:
          - link /Feature request/
        - listitem:
          - link /Billing question/
        - listitem:
          - link /Cannot login to dashboard/
    `);
    },
  );

  test(
    "the app works when the WebSocket connection is blocked",
    {
      annotation: {
        type: "description",
        description:
          "routeWebSocket で /api/ws への接続をブロックしても、アプリは壊れず一覧表示と手動作成が機能する(WS はプログレッシブエンハンスメント)ことを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("block the realtime socket before loading", async () => {
        // 接続そのものを成立させない: ハンドラ内で ws を触らないことで
        // ブラウザ側の接続を宙吊りにする(サーバへ到達させない)。
        await page.routeWebSocket(/\/api\/ws/, () => {
          // no-op: never connectToServer, so the client socket never opens.
        });
      });

      await test.step("load the tickets list with the socket blocked", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await expect(page.getByTestId("tickets-load-error")).toBeHidden();
        await snap(page, testInfo, "WSブロック時の一覧");
      });

      await test.step("manual create still works", async () => {
        await page.getByRole("button", { name: "New ticket" }).click();
        await page.getByLabel("Subject").fill("WS blocked: manual create still works");
        await page.getByRole("button", { name: "Create" }).click();
        await expect(
          page
            .getByTestId("ticket-row")
            .filter({ hasText: "WS blocked: manual create still works" }),
        ).toBeVisible();
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "手動作成成功");
      });
    },
  );

  test(
    "a dropped WebSocket surfaces no error UI",
    {
      annotation: {
        type: "description",
        description:
          "routeWebSocket で一度接続させた後に切断しても、アプリはエラーUIを出さず一覧が使える(仕様の緩和条項: 再接続の実証が難しい場合はエラー非表示まで)ことを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("let the socket connect, then drop it", async () => {
        await page.routeWebSocket(/\/api\/ws/, async (ws) => {
          // 接続はサーバへ通す(自動更新の通常経路)が、直後に切断して
          // クライアントの再接続/耐障害パスを起動する。
          ws.connectToServer();
          await ws.close();
        });
      });

      await test.step("load the tickets list over the dropped socket", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "切断後の一覧");
      });

      await test.step("no realtime error UI is shown and the list stays usable", async () => {
        // 緩和条項: 再接続後の反映までは検証せず、「切断でエラーUIが出ない」ことを固定。
        await expect(page.getByTestId("realtime-error")).toHaveCount(0);
        await expect(page.getByTestId("tickets-load-error")).toBeHidden();
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "エラーUIなし");
      });
    },
  );
});
