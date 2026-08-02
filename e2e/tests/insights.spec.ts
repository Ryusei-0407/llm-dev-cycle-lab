import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { snap } from "../helpers/snap";

// E2E for the insights feature (spec: specs/insights.md E2E観点). /insights is an
// agent-only analytics view mounted in AppShell: stat cards + two TanStack Charts
// (SVG). These verify UI plumbing only (nav → 統計カード → チャート描画 / 固定値の
// 配線 / customer の出し分け + forbidden), not chart pixels — VRT owns visuals.
//
// 主経路(@smoke)は実バックエンド(既定の agent セッション)で、共有DBのため数値の
// 絶対値は見ずカードに数字が出ること・SVG が可視なことだけを見る。配線の決定性は
// モックレーンで page.route が固定値(byStatus 5/2/7・unassigned 3 等)を返し、
// カードの数値と auth バーのラベルを厳密照合する。customer は出し分け + forbidden。

// The mock-lane insights payload (spec E2E観点 2)。byLabel は auth=4/billing=1/
// api=0、resolvedByDay は末尾の日だけ count 2、他 0。日付は照合に使わないので
// 相対値でよいが、要素数は 14(末尾=今日)にしておく。
function mockInsightsPayload() {
  const today = new Date();
  const resolvedByDay = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today.getTime() - (13 - i) * 24 * 3600_000);
    return { date: d.toISOString().slice(0, 10), count: i === 13 ? 2 : 0 };
  });
  return {
    byStatus: { open: 5, in_progress: 2, resolved: 7 },
    byPriority: { low: 1, medium: 1, high: 1 },
    unassigned: 3,
    byLabel: [
      { name: "api", color: "#6a8dff", count: 0 },
      { name: "auth", color: "#e2626b", count: 4 },
      { name: "billing", color: "#f2c94c", count: 1 },
    ],
    resolvedByDay,
  };
}

// Stub the oRPC insights procedure at the network layer (json 封筒二重: RPCHandler
// wire は {"json": payload})。app-shell.spec の stubBulkTickets と同じ流儀。
async function stubInsights(page: Page, payload: unknown) {
  await page.routeWebSocket(/\/api\/ws$/, () => {});
  await page.route("**/api/rpc/tickets/insights", (route) =>
    route.fulfill({ json: { json: payload } }),
  );
}

test.describe("insights view @feature-insights", () => {
  test(
    "agent navigates to insights and sees stat cards and both charts @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者でサイドバーの nav-insights から /insights へ遷移し、h1「インサイト」・統計カード4枚(insight-stat-open/in_progress/resolved/unassigned の各 insight-value が数字)・チャート2枚(insight-chart-trend / insight-chart-labels 内に svg が可視)が出る主経路を検証(共有DBのため数値の絶対値は見ない)",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("担当者としてサイドバーからインサイトを開く", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("app-sidebar").getByTestId("nav-insights")).toBeVisible();
        await snap(page, testInfo, "インサイトへの導線");
        await page.getByTestId("app-sidebar").getByTestId("nav-insights").click();
        await expect(page).toHaveURL(/\/insights$/);
        await expect(page.getByRole("heading", { name: "インサイト" })).toBeVisible();
        await snap(page, testInfo, "インサイト表示");
      });

      await test.step("統計カード4枚に数値が出ることを確認する", async () => {
        for (const key of ["open", "in_progress", "resolved", "unassigned"]) {
          const card = page.getByTestId(`insight-stat-${key}`);
          await expect(card).toBeVisible();
          // 共有DBのため絶対値は見ず、数字が描画されていることだけを見る。
          await expect(card.getByTestId("insight-value")).toHaveText(/\d+/);
        }
        await snap(page, testInfo, "統計カード");
      });

      await test.step("チャート2枚に svg が描画されることを確認する", async () => {
        await expect(page.getByTestId("insight-chart-trend").locator("svg")).toBeVisible();
        await expect(page.getByTestId("insight-chart-labels").locator("svg")).toBeVisible();
        await expect(page.getByTestId("insights-error")).toHaveCount(0);
        await snap(page, testInfo, "チャート描画");
      });

      // 構造アサーション: ページの骨格(見出し + 統計カード群 + チャート領域)の
      // role と順序だけを固定する。数値・SVG 内部は上の toBeVisible で別途担保
      // (ローカルは ignoreSnapshots で aria もスキップされる)。
      await expect(page.getByRole("main")).toMatchAriaSnapshot(`
        - heading "インサイト"
      `);
    },
  );

  test(
    "mock-lane insights wires fixed values into stat cards and the label chart",
    {
      annotation: {
        type: "description",
        description:
          "page.route で tickets.insights を固定値(byStatus 5/2/7・unassigned 3・byLabel auth=4/billing=1/api=0)にスタブすると、統計カードの数値が 5/2/7/3 と表示され、ラベルチャート(insight-chart-labels)に auth のラベル文字が現れることを検証(配線の決定性)",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("insights を固定値にスタブする", async () => {
        await stubInsights(page, mockInsightsPayload());
      });

      await test.step("インサイトを開いてカードの固定値を確認する", async () => {
        await page.goto("/insights");
        await expect(page.getByRole("heading", { name: "インサイト" })).toBeVisible();
        await expect(page.getByTestId("insight-stat-open").getByTestId("insight-value")).toHaveText(
          "5",
        );
        await expect(
          page.getByTestId("insight-stat-in_progress").getByTestId("insight-value"),
        ).toHaveText("2");
        await expect(
          page.getByTestId("insight-stat-resolved").getByTestId("insight-value"),
        ).toHaveText("7");
        await expect(
          page.getByTestId("insight-stat-unassigned").getByTestId("insight-value"),
        ).toHaveText("3");
        await snap(page, testInfo, "固定値カード");
      });

      await test.step("ラベルチャートに auth のラベルが現れることを確認する", async () => {
        // バー色・座標ではなく、ラベル文字(aria or DOM 上のテキスト)で配線を見る。
        await expect(page.getByTestId("insight-chart-labels")).toContainText("auth");
        await snap(page, testInfo, "ラベルチャート");
      });
    },
  );

  test.describe("as a customer", () => {
    // insights は agent 専用。customer は project 既定(agent)から seed の customer
    // storageState に opt-in(kanban / copilot spec と同じ .auth/customer.json)。
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "a customer has no insights nav and sees the forbidden panel at /insights",
      {
        annotation: {
          type: "description",
          description:
            "customer セッションではサイドバーに nav-insights が無く、/insights へ直アクセスすると(リダイレクトせず)insights-forbidden が表示され、統計カードもチャートも出ないことを検証(agent 専用の出し分けと直アクセス防御)",
        },
      },
      async ({ page }, testInfo) => {
        await test.step("顧客サイドバーに nav-insights が無い", async () => {
          await page.goto("/tickets");
          await expect(page.getByTestId("app-sidebar")).toBeVisible();
          await expect(page.getByTestId("nav-insights")).toHaveCount(0);
          await snap(page, testInfo, "顧客に導線無し");
        });

        await test.step("/insights へ直アクセスすると forbidden が出る", async () => {
          await page.goto("/insights");
          await expect(page.getByTestId("insights-forbidden")).toBeVisible();
          // リダイレクトしない(board-forbidden の流儀): URL は /insights のまま。
          await expect(page).toHaveURL(/\/insights$/);
          await expect(page.getByTestId("insight-stat-open")).toHaveCount(0);
          await expect(page.getByTestId("insight-chart-trend")).toHaveCount(0);
          await snap(page, testInfo, "アクセス禁止");
        });
      },
    );
  });
});
