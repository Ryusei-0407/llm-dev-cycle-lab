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

      await test.step("チケット一覧を開きライブ接続を待つ", async () => {
        // 自動更新の前提となる /api/ws 接続が確立するのを待つ。固定待ちは使わず、
        // WebSocket ハンドシェイクの成立をイベントで待つ。接続はページロード中に
        // 張られるため、リスナーは goto より先に登録する(後付けだと取り逃がす)
        const liveSocket = page.waitForEvent("websocket", {
          predicate: (ws) => ws.url().includes("/api/ws"),
        });
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await liveSocket;
        await snap(page, testInfo, "初期表示");
      });

      await test.step("別ソース(API)からチケットを作成する", async () => {
        await createTicket(request, subject);
      });

      await test.step("リロード無しで新チケットが表示されることを確認する", async () => {
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
      await test.step("読み込み前にリアルタイム接続をブロックする", async () => {
        // 接続そのものを成立させない: ハンドラ内で ws を触らないことで
        // ブラウザ側の接続を宙吊りにする(サーバへ到達させない)。
        await page.routeWebSocket(/\/api\/ws/, () => {
          // no-op: never connectToServer, so the client socket never opens.
        });
      });

      await test.step("接続ブロック状態でチケット一覧を読み込む", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await expect(page.getByTestId("tickets-load-error")).toBeHidden();
        await snap(page, testInfo, "WSブロック時の一覧");
      });

      await test.step("手動のチケット作成が機能することを確認する", async () => {
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
      await test.step("接続を確立させてから切断する", async () => {
        await page.routeWebSocket(/\/api\/ws/, async (ws) => {
          // 接続はサーバへ通す(自動更新の通常経路)が、直後に切断して
          // クライアントの再接続/耐障害パスを起動する。
          ws.connectToServer();
          await ws.close();
        });
      });

      await test.step("切断状態でチケット一覧を読み込む", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row").first()).toBeVisible();
        await snap(page, testInfo, "切断後の一覧");
      });

      await test.step("エラーUIが出ず一覧が使えることを確認する", async () => {
        // 緩和条項: 再接続後の反映までは検証せず、「切断でエラーUIが出ない」ことを固定。
        await expect(page.getByTestId("realtime-error")).toHaveCount(0);
        await expect(page.getByTestId("tickets-load-error")).toBeHidden();
        await expect(page.getByTestId("ticket-error")).toBeHidden();
        await snap(page, testInfo, "エラーUIなし");
      });
    },
  );

  // ---- adversarial review pins (refutation-pinned, exempt from the E2E cap) ----

  test.describe("unauthenticated socket @pinned", () => {
    // ログインしていないコンテキストからの接続試行(cookie 無し)
    test.use({ storageState: { cookies: [], origins: [] } });

    test(
      "an unauthenticated WebSocket is rejected with close code 1008 @pinned",
      {
        annotation: {
          type: "description",
          description:
            "セッション cookie 無しの /api/ws 接続がサーバに close code 1008 で拒否されることを検証(認証ガードの回帰検知)",
        },
      },
      async ({ page }) => {
        await page.goto("/login");
        const closeCode = await page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const scheme = location.protocol === "https:" ? "wss" : "ws";
              const ws = new WebSocket(`${scheme}://${location.host}/api/ws`);
              ws.onclose = (event) => resolve(event.code);
              setTimeout(() => reject(new Error("no close event")), 10_000);
            }),
        );
        expect(closeCode).toBe(1008);
      },
    );
  });

  test(
    "a reply posted elsewhere appears on an open ticket detail without reload @pinned",
    {
      annotation: {
        type: "description",
        description:
          "詳細ページを開いたまま、別ソース(API)からの返信が reload なしでスレッドに反映される(get の invalidate)ことを検証",
      },
    },
    async ({ page, request }, testInfo) => {
      const subject = `WS detail live: ${test.info().testId}`;
      let ticketId = "";
      await test.step("テスト用チケットを準備して詳細を開く", async () => {
        ticketId = await createTicket(request, subject);
        const liveSocket = page.waitForEvent("websocket", {
          predicate: (ws) => ws.url().includes("/api/ws"),
        });
        await page.goto(`/tickets/${ticketId}`);
        await expect(page.getByTestId("ticket-subject")).toContainText(subject);
        await liveSocket;
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("APIで返信を投稿しライブ反映を確認する", async () => {
        const before = await page.getByTestId("message-item").count();
        const res = await request.post("/api/rpc/tickets/reply", {
          data: { json: { ticketId, body: "Live reply over the wire." } },
        });
        expect(res.ok()).toBeTruthy();
        await expect(page.getByTestId("message-item")).toHaveCount(before + 1);
        await expect(page.getByTestId("message-item").last()).toContainText("Live reply");
        await snap(page, testInfo, "自動反映後");
      });
    },
  );
});
