import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

// Visual Regression (spec なし・テスト基盤): 主要画面の見た目を toHaveScreenshot
// で固定し、UI の意図しない変化をピクセル差分で検出する。差分が出た失敗は
// 期待/実際/差分 の3枚組として PR メディアコメントに表示される
// (scripts/pr-media-comment.mjs が -expected/-actual/-diff 添付を拾う)。
//
// 決定性の作り方:
// - 表示データは全て page.route で固定 — 共有DBの並走 create・seed の変化に
//   影響されない(モック先行の失敗系テストと同じ流儀)
// - baseline は linux(CI)でのみ生成・比較する。ローカル(darwin)はフォント等の
//   レンダリング差で必ずずれるため、playwright.config の ignoreSnapshots が
//   ローカルの比較をスキップする
// - baseline 更新(意図した UI 変更時): 対象ブランチで
//   `gh workflow run update-snapshots.yml --ref <branch>` → 再生成コミットが
//   ブランチに積まれ、PR の Files タブで新旧画像の比較ができる
// VRT は静的な見た目の検証なので録画はノイズ(かつ CI 時間の無駄)。成果物は
// スクリーンショット — 成功時も撮影画像を添付して PR コメントに出す。
// (video は worker スコープのオプションなのでファイルのトップレベルに置く)
test.use({ video: "off" });

test.describe("visual regression @feature-visual @visual", () => {
  const LABELS = [
    { name: "auth", color: "#e2626b" },
    { name: "billing", color: "#f2c94c" },
    { name: "request", color: "#9a6ae2" },
  ];
  const TICKETS = [
    {
      id: "00000000-0000-7000-8000-00000000fa01",
      number: 1,
      subject: "Cannot sign in from SSO",
      status: "open",
      priority: "high",
      requesterEmail: "casey@example.com",
      assigneeEmail: "aki@example.com",
      labels: [LABELS[0]],
      createdAt: "2026-07-01T09:00:00.000Z",
      updatedAt: "2026-07-01T09:20:00.000Z",
    },
    {
      id: "00000000-0000-7000-8000-00000000fa02",
      number: 2,
      subject: "Invoice PDF renders blank",
      status: "in_progress",
      priority: "medium",
      requesterEmail: "morgan@example.com",
      assigneeEmail: null,
      labels: [LABELS[1]],
      createdAt: "2026-07-02T09:00:00.000Z",
      updatedAt: "2026-07-02T09:00:00.000Z",
    },
    {
      id: "00000000-0000-7000-8000-00000000fa03",
      number: 3,
      subject: "Feature request: weekly digest",
      status: "resolved",
      priority: "low",
      requesterEmail: "sam@example.com",
      assigneeEmail: null,
      labels: [LABELS[2]],
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    },
  ];
  const DETAIL = {
    ticket: TICKETS[0],
    // ticket-model のイベント行(状態変更の履歴)も1件固定表示する。
    events: [
      {
        id: "00000000-0000-7000-8000-00000000fc01",
        type: "status_changed",
        actorEmail: "aki@example.com",
        payload: { from: "open", to: "in_progress" },
        createdAt: "2026-07-01T09:10:00.000Z",
      },
    ],
    messages: [
      {
        id: "00000000-0000-7000-8000-00000000fb01",
        ticketId: TICKETS[0].id,
        authorEmail: "casey@example.com",
        authorRole: "customer",
        body: "SSO login loops back to the provider every time since this morning.",
        createdAt: "2026-07-01T09:05:00.000Z",
      },
      {
        id: "00000000-0000-7000-8000-00000000fb02",
        ticketId: TICKETS[0].id,
        authorEmail: "aki@example.com",
        authorRole: "agent",
        body: "Thanks for the report — checking our identity provider integration now.",
        createdAt: "2026-07-01T09:20:00.000Z",
      },
    ],
  };

  // oRPC RPCHandler の wire は {"json": <output>} 封筒(tickets.spec.ts 参照)。
  async function stubTicketData(page: Page) {
    await page.route("**/api/rpc/tickets/list", (route) =>
      route.fulfill({ json: { json: TICKETS } }),
    );
    // 一覧ページは listPage(カーソルページネーション)を使う。1ページで完結。
    await page.route("**/api/rpc/tickets/listPage", (route) =>
      route.fulfill({ json: { json: { items: TICKETS, nextCursor: null } } }),
    );
    await page.route("**/api/rpc/tickets/get", (route) =>
      route.fulfill({ json: { json: DETAIL } }),
    );
    // 詳細の agent 操作列(status/assignee/labels)が使うカタログ系も固定する。
    await page.route("**/api/rpc/tickets/labels", (route) =>
      route.fulfill({ json: { json: LABELS } }),
    );
    await page.route("**/api/rpc/tickets/agents", (route) =>
      route.fulfill({ json: { json: [{ email: "aki@example.com", name: "Aki Agent" }] } }),
    );
    // サイドバーの受信トレイバッジ。実DBの件数に依存させない(固定値 2)。
    await page.route("**/api/rpc/tickets/inboxCount", (route) =>
      route.fulfill({ json: { json: 2 } }),
    );
  }

  // 成功時の成果物: 比較に使ったのと同条件で撮った現画面を添付する。
  // PR コメントはこれを「スクリーンショット」として表示する(録画は撮らない)。
  // body 添付は JSON レポート上で path を持たず、メディア収集(path 前提)から
  // 漏れる — 出力ディレクトリに保存して path で添付する。
  async function attachShot(page: Page, name: string) {
    const file = test.info().outputPath(`shot-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await test.info().attach(`shot: ${name}`, { path: file, contentType: "image/png" });
  }

  test.beforeEach(async ({ page }) => {
    // 撮影中の WS 無効化→再フェッチを止める(kanban.spec.ts と同じ隔離)。
    await page.routeWebSocket(/\/api\/ws$/, () => {});
  });

  test.describe("logged out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test(
      "login page",
      {
        annotation: {
          type: "description",
          description: "ログイン画面の見た目を baseline と比較(未ログイン状態)",
        },
      },
      async ({ page }) => {
        await test.step("ログイン画面を開いて撮影する", async () => {
          await page.goto("/login");
          await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
          await expect(page).toHaveScreenshot("login.png", { fullPage: true });
          await attachShot(page, "login");
        });
      },
    );
  });

  test(
    "tickets list",
    {
      annotation: {
        type: "description",
        description: "チケット一覧(固定3件)の見た目を baseline と比較",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      await test.step("チケット一覧を開いて撮影する", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("ticket-row")).toHaveCount(3);
        await expect(page).toHaveScreenshot("tickets.png", { fullPage: true });
        await attachShot(page, "tickets");
      });
    },
  );

  test(
    "ticket detail",
    {
      annotation: {
        type: "description",
        description: "チケット詳細(スレッド2件+返信欄)の見た目を baseline と比較",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      await test.step("チケット詳細を開いて撮影する", async () => {
        await page.goto(`/tickets/${TICKETS[0].id}`);
        await expect(page.getByTestId("ticket-subject")).toContainText("Cannot sign in from SSO");
        await expect(page).toHaveScreenshot("ticket-detail.png", { fullPage: true });
        await attachShot(page, "ticket-detail");
      });
    },
  );

  test(
    "inbox (empty)",
    {
      annotation: {
        type: "description",
        description: "受信トレイの空状態(inbox-empty 表示 + 0件でバッジ非表示)を baseline と比較",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      // 後から登録した route が優先される — 空の受信トレイと 0 件バッジに上書き。
      await page.route("**/api/rpc/tickets/listPage", (route) =>
        route.fulfill({ json: { json: { items: [], nextCursor: null } } }),
      );
      await page.route("**/api/rpc/tickets/inboxCount", (route) =>
        route.fulfill({ json: { json: 0 } }),
      );
      await test.step("空の受信トレイを開いて撮影する", async () => {
        await page.goto("/inbox");
        await expect(page.getByTestId("inbox-empty")).toBeVisible();
        await expect(page).toHaveScreenshot("inbox-empty.png", { fullPage: true });
        await attachShot(page, "inbox-empty");
      });
    },
  );

  test(
    "command palette (open)",
    {
      annotation: {
        type: "description",
        description:
          "コマンドパレットを開いた状態(ナビ項目 + 検索入力)を baseline と比較。開閉はサイドバーの検索ボタン経由(クリック経路の担保を兼ねる)",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      await test.step("サイドバーの検索ボタンでパレットを開いて撮影する", async () => {
        await page.goto("/tickets");
        await page.getByTestId("sidebar-search").click();
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await expect(page).toHaveScreenshot("palette.png", { fullPage: true });
        await attachShot(page, "palette");
      });
    },
  );

  test(
    "copilot panel (open)",
    {
      annotation: {
        type: "description",
        description:
          "Copilot ドックパネルを開いた状態(入力前の空パネル)を baseline と比較。SSE の逐次表示は VRT に不向きなので送信はしない",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      await test.step("Copilot パネルを開いて撮影する", async () => {
        await page.goto("/tickets");
        await page.getByTestId("copilot-launch").click();
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await expect(page).toHaveScreenshot("copilot.png", { fullPage: true });
        await attachShot(page, "copilot");
      });
    },
  );

  test(
    "insights",
    {
      annotation: {
        type: "description",
        description:
          "インサイト画面(統計カード4枚 + 推移/ラベルの2チャート)を固定データで baseline と比較",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      // チャートの軸・形状まで決定的にする(日付も固定)。
      const resolvedByDay = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, "0")}`,
        count: [0, 1, 0, 2, 1, 0, 3, 1, 2, 0, 1, 4, 2, 1][i],
      }));
      await page.route("**/api/rpc/tickets/insights", (route) =>
        route.fulfill({
          json: {
            json: {
              byStatus: { open: 5, in_progress: 2, resolved: 7 },
              byPriority: { low: 4, medium: 6, high: 4 },
              unassigned: 3,
              byLabel: [
                { name: "api", color: "#6a8dff", count: 2 },
                { name: "auth", color: "#e2626b", count: 4 },
                { name: "billing", color: "#f2c94c", count: 1 },
                { name: "email", color: "#27a644", count: 0 },
                { name: "request", color: "#9a6ae2", count: 3 },
              ],
              resolvedByDay,
            },
          },
        }),
      );
      await test.step("インサイトを開いて撮影する", async () => {
        await page.goto("/insights");
        await expect(page.getByTestId("insight-chart-labels")).toBeVisible();
        await expect(page).toHaveScreenshot("insights.png", { fullPage: true });
        await attachShot(page, "insights");
      });
    },
  );

  test(
    "kanban board",
    {
      annotation: {
        type: "description",
        description: "カンバンボード(3列・固定カード)の見た目を baseline と比較",
      },
    },
    async ({ page }) => {
      await stubTicketData(page);
      await test.step("ボードを開いて撮影する", async () => {
        await page.goto("/board");
        await expect(page.getByTestId("kanban-column-open")).toBeVisible();
        await expect(page).toHaveScreenshot("board.png", { fullPage: true });
        await attachShot(page, "board");
      });
    },
  );
});
