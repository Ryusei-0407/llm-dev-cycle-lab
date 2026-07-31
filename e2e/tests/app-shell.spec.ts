import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { snap } from "../helpers/snap";

// E2E for the app-shell feature (spec: specs/app-shell.md E2E観点). The signed-in
// TopNav is replaced by a left sidebar + full-width main pane (App shell), and
// the /tickets list becomes a TanStack Virtual infinite scroll over
// tickets.listPage. These verify plumbing only (shell 出し分け・ナビ遷移・
// 仮想化されたインフィニティスクロール), not content — role と順序でアサートする。
//
// Lanes:
// - @smoke(実バックエンド・agent): サイドバー表示と Board/Tickets ナビ遷移。
//   表示は共有シードのアンカー("Billing question" = SUP-2)で確認する
//   (絶対件数は共有DBの並走 create で前後するため使わない)。
// - モックレーン: listPage を page.route で2ページ固定し、最下部スクロールで
//   2ページ目("Bulk ticket 60")が読み込まれること + DOM 上の行数が総数 60 を
//   大きく下回ること(仮想化の証拠)を見る。他エンドポイントのスタブは
//   visual.spec.ts の流儀(oRPC 封筒 {"json": ...}、routeWebSocket 無効化)。
// - customer: サイドバーに Board リンクが無い(agent 専用)ことと、自分の
//   チケット(既存シードアンカー)が一覧に出ることを見る。
test.describe("app-shell @feature-app-shell", () => {
  test(
    "agent sees the sidebar and navigates tickets ⇄ board @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者で /tickets を開くと app-sidebar に Tickets / Board リンクが出て一覧に既存シード(SUP-2「Billing question」)が見え、サイドバーの Board リンクで /board のカンバンへ、Tickets リンクで一覧へ戻れる主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("チケット一覧を開きサイドバーを確認する", async () => {
        await page.goto("/tickets");
        // サイドバー(nav コンテナ)とその中の2リンクを確認する。
        const sidebar = page.getByTestId("app-sidebar");
        await expect(sidebar).toBeVisible();
        await expect(sidebar.getByTestId("nav-tickets")).toBeVisible();
        await expect(sidebar.getByTestId("nav-board")).toBeVisible();
        // 一覧の表示はシードのアンカーで確認する(絶対件数は使わない: 共有DBで
        // 他ファイルの create が並走すると行数が前後する)。SUP-2「Billing question」。
        await expect(
          page.getByTestId("ticket-row").filter({ hasText: "Billing question" }),
        ).toBeVisible();
        await snap(page, testInfo, "一覧+サイドバー");
      });

      await test.step("サイドバーの Board リンクでボードへ遷移する", async () => {
        await page.getByTestId("app-sidebar").getByTestId("nav-board").click();
        await expect(page).toHaveURL("/board");
        await expect(page.getByTestId("kanban-column-open")).toBeVisible();
        await snap(page, testInfo, "ボード遷移");
      });

      await test.step("サイドバーの Tickets リンクで一覧へ戻る", async () => {
        await page.getByTestId("app-sidebar").getByTestId("nav-tickets").click();
        await expect(page).toHaveURL("/tickets");
        await expect(page.getByTestId("ticket-list")).toBeVisible();
        await snap(page, testInfo, "一覧へ復帰");
      });

      // Structural assertion: the signed-in shell (sidebar container), role と
      // 順序のみ — サイドバーは Tickets / Board のナビリンクと Sign out ボタンを
      // 含む。コピーやレイアウト変更に耐える。
      await expect(page.getByTestId("app-sidebar")).toMatchAriaSnapshot(`
      - link "Tickets"
      - link "Board"
      - button "Sign out"
    `);
    },
  );

  test(
    "infinite scroll loads the second page while virtualizing rows",
    {
      annotation: {
        type: "description",
        description:
          "listPage を2ページ固定(1ページ目50件+nextCursor / 2ページ目10件+nextCursor null)したモックレーンで、一覧を最下部までスクロールすると2ページ目が fetch され「Bulk ticket 60」の行が現れ、かつ DOM 上の ticket-row 数が総数60を大きく下回る(< 40 = 仮想化の証拠)ことを検証",
      },
    },
    async ({ page }, testInfo) => {
      await stubBulkTickets(page);

      await test.step("一覧を開き1ページ目が仮想化表示されることを確認する", async () => {
        await page.goto("/tickets");
        // 1ページ目の先頭行が見える(部分一致だと 10..19 等にも当たるため
        // 番号の直後を非数字に固定)。
        await expect(
          page.getByTestId("ticket-row").filter({ hasText: /Bulk ticket 1(?!\d)/ }),
        ).toBeVisible();
        // 仮想化: 総数(1ページ目だけでも50、末尾まで読めば60)より DOM 行数は
        // 大幅に少ない。可視ウィンドウ + オーバースキャンぶんだけが実体化する。
        expect(await page.getByTestId("ticket-row").count()).toBeLessThan(40);
        // 敵対的レビューの反例の固定: クライアントで並べ替えるミューテーション
        // (subject の辞書順ソート等)が全テストを通過していた。先頭の行列が
        // サーバ返却順そのままであることをアサートする(辞書順なら 1 の次は 10)。
        expect((await page.getByTestId("ticket-link").allTextContents()).slice(0, 5)).toEqual([
          "Bulk ticket 1",
          "Bulk ticket 2",
          "Bulk ticket 3",
          "Bulk ticket 4",
          "Bulk ticket 5",
        ]);
        await snap(page, testInfo, "1ページ目");
      });

      await test.step("最下部までスクロールして2ページ目を読み込む", async () => {
        // 明示ボタンは無い(可視末尾が末尾-5行に達すると次ページを fetch する)。
        // 仮想スクロール領域を最下部へ送り、2ページ目の最終行が実体化するまで
        // スクロールを繰り返す(固定待ちは使わない)。
        await scrollListToBottom(page);
        await expect(
          page.getByTestId("ticket-row").filter({ hasText: "Bulk ticket 60" }),
        ).toBeVisible();
        // 2ページ読み込み後も仮想化は維持される(全60行は実体化しない)。
        expect(await page.getByTestId("ticket-row").count()).toBeLessThan(40);
        // 順序固定の続き: ページ境界をまたいでもサーバ順(…58, 59, 60)のまま。
        expect((await page.getByTestId("ticket-link").allTextContents()).slice(-3)).toEqual([
          "Bulk ticket 58",
          "Bulk ticket 59",
          "Bulk ticket 60",
        ]);
        await snap(page, testInfo, "2ページ目到達");
      });

      // Structural assertion: 仮想化後も ticket-list は list として行(listitem)を
      // 内包する。可視ウィンドウの1行以上が listitem として現れることを固定する。
      await expect(page.getByTestId("ticket-list")).toMatchAriaSnapshot(`
      - list:
        - listitem
    `);
    },
  );

  // 顧客セッションに opt-in(project 既定は agent)。customer-portal.spec.ts と
  // 同じ storageState を使う(setup が生成する e2e/.auth/customer.json)。
  // test.use は describe/file スコープでのみ有効なので、顧客テストは入れ子の
  // describe に分けてセッションを切り替える。
  test.describe("customer session", () => {
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "customer's sidebar hides Board and lists their own tickets",
      {
        annotation: {
          type: "description",
          description:
            "顧客セッションで /tickets を開くと app-sidebar に Tickets リンクはあるが Board リンク(agent 専用)が無く、一覧に自分のチケット(既存シードアンカー「Billing question」)が表示されることを検証",
        },
      },
      async ({ page }, testInfo) => {
        await test.step("顧客としてチケット一覧を開く", async () => {
          await page.goto("/tickets");
          await expect(page.getByTestId("app-sidebar")).toBeVisible();
          await snap(page, testInfo, "顧客の一覧");
        });

        await test.step("サイドバーに Board が無く Tickets はあることを確認する", async () => {
          const sidebar = page.getByTestId("app-sidebar");
          await expect(sidebar.getByTestId("nav-tickets")).toBeVisible();
          await expect(sidebar.getByTestId("nav-board")).toHaveCount(0);
          await snap(page, testInfo, "Board リンクなし");
        });

        await test.step("自分のチケットが一覧に表示されることを確認する", async () => {
          // シードは全て customer 所有(customer-portal spec)。アンカーで存在を見る。
          await expect(
            page.getByTestId("ticket-row").filter({ hasText: "Billing question" }),
          ).toBeVisible();
          await snap(page, testInfo, "自分のチケット表示");
        });
      },
    );
  });
});

// listPage を2ページ固定するモックレーンのスタブ。oRPC RPCHandler の wire は
// {"json": <output>} 封筒(visual.spec.ts / tickets.spec.ts 参照)。listPage の
// 返却は { items, nextCursor } を想定する(仕様: limit 50・nextCursor を pageParam)。
// 1ページ目: "Bulk ticket 1".."Bulk ticket 50"(nextCursor あり)、
// 2ページ目: "Bulk ticket 51".."Bulk ticket 60"(nextCursor null)。
async function stubBulkTickets(page: Page) {
  // 撮影中の WS 無効化(realtime invalidation による再フェッチ割り込みを止める)。
  await page.routeWebSocket(/\/api\/ws$/, () => {});

  const makeTicket = (n: number) => ({
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    number: n,
    subject: `Bulk ticket ${n}`,
    status: "open",
    priority: "medium",
    requesterEmail: "casey@example.com",
    assigneeEmail: null,
    labels: [],
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
  });
  const page1 = Array.from({ length: 50 }, (_, i) => makeTicket(i + 1));
  const page2 = Array.from({ length: 10 }, (_, i) => makeTicket(i + 51));

  await page.route("**/api/rpc/tickets/listPage", (route) => {
    // pageParam(cursor)は body の json 封筒に載る。1回目は cursor 無し/null、
    // 2回目は1ページ目が返した nextCursor("page-2")で来る。
    const body = route.request().postData() ?? "";
    const isSecondPage = body.includes("page-2");
    const payload = isSecondPage
      ? { items: page2, nextCursor: null }
      : { items: page1, nextCursor: "page-2" };
    return route.fulfill({ json: { json: payload } });
  });

  // 一覧ページが付随して引く可能性のあるカタログ系も固定する(visual.spec.ts 流儀)。
  await page.route("**/api/rpc/tickets/labels", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/api/rpc/tickets/agents", (route) => route.fulfill({ json: { json: [] } }));
}

// 仮想スクロール領域を最下部へ送る。行が絶対配置で総数ぶんは実体化しないため、
// スクロール要素の scrollTop を scrollHeight まで押し上げ、末尾行のトリガで次ページが
// fetch → 実体化するまで繰り返す。固定待ちは使わず、目的の行が現れるまで expect で待つ。
async function scrollListToBottom(page: Page) {
  const scroller = page.getByTestId("ticket-list");
  const target = page.getByTestId("ticket-row").filter({ hasText: "Bulk ticket 60" });
  await expect(async () => {
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(target).toBeVisible({ timeout: 1000 });
  }).toPass();
}
