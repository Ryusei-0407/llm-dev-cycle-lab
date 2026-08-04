import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for the saved-views feature (spec: specs/saved-views.md E2E観点). An agent
// names the current /tickets filter combination and it persists server-side as a
// personal saved view, reachable one-click from the sidebar's ビュー section
// (below the existing presets). These verify plumbing only (フィルタ→保存→
// サイドバー出現→適用遷移→リロード残存→削除、と失敗2)—content ではなく構造を
// アサートする。未実装なので RED(view-save ボタン不在 / viewsCreate 404 相当で落ちる)。
//
// - @smoke(既定 agent セッション): 主経路を通す。作成するビュー名はテスト内で
//   一意にし、共有シード(ここでは初期0件の user_views)を汚さない。
// - 失敗1: 空名確定 → view-error 表示、viewsCreate は呼ばれない(route で監視)。
// - 失敗2(customer セッション): ビュー節が無い(sidebar-user-view 0 件)+
//   request で viewsCreate 直 POST → FORBIDDEN。
test.describe("saved-views @feature-saved-views", () => {
  // テスト内で一意なビュー名(共有 DB を汚さない・並走/リトライで衝突しない)。
  const VIEW_NAME = `E2E view ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  test(
    "agent saves the current filter as a view, applies it from the sidebar, and deletes it @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が /tickets で priority=high を適用し「ビューとして保存」で名前を付けて保存すると、サイドバーのビュー節にそのビューが現れ、別ページへ移動後にクリックすると /tickets?priority=high へ遷移してフィルタが復元し、リロード後もビューが残存し、削除ボタンで一覧から消える主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("フィルタ未適用では保存ボタンが出ないことを確認する", async () => {
        await page.goto("/tickets");
        await expect(page.getByTestId("view-save")).toHaveCount(0);
        await snap(page, testInfo, "フィルタ未適用");
      });

      await test.step("priority=high フィルタを適用し保存ボタンを出す", async () => {
        // フィルタ URL 契約(/tickets?priority=high)は既存のまま(spec: 契約を変えない)。
        await page.goto("/tickets?priority=high");
        await expect(page.getByTestId("view-save")).toBeVisible();
        await snap(page, testInfo, "フィルタ適用");
      });

      await test.step("ビュー名を入力して保存する", async () => {
        await page.getByTestId("view-save").click();
        await page.getByTestId("view-name-input").fill(VIEW_NAME);
        await page.getByTestId("view-save-confirm").click();
        // 成功: 入力 UI が閉じ、サイドバーの一覧が即時更新される。
        await expect(page.getByTestId("view-name-input")).toHaveCount(0);
        await expect(
          page.getByTestId("sidebar-user-view").filter({ hasText: VIEW_NAME }),
        ).toBeVisible();
        await snap(page, testInfo, "保存後サイドバー出現");
      });

      await test.step("別ページへ移動してからサイドバーのビューで適用する", async () => {
        await page.goto("/board");
        await expect(page.getByTestId("kanban-column-open")).toBeVisible();
        await page.getByTestId("sidebar-user-view").filter({ hasText: VIEW_NAME }).click();
        // filters にあるキー(priority)だけが search に載る。
        await expect(page).toHaveURL(/\/tickets\?(?:.*&)?priority=high(?:&|$)/);
        // フィルタが復元している(priority セレクトが high)。
        await expect(page.getByTestId("filter-priority")).toHaveValue("high");
        await snap(page, testInfo, "ビュー適用遷移");
      });

      await test.step("リロード後もビューが残存する(サーバ永続)", async () => {
        await page.reload();
        await expect(
          page.getByTestId("sidebar-user-view").filter({ hasText: VIEW_NAME }),
        ).toBeVisible();
        await snap(page, testInfo, "リロード後残存");
      });

      await test.step("削除ボタンでビューが一覧から消える", async () => {
        const row = page.getByTestId("sidebar-user-view").filter({ hasText: VIEW_NAME });
        await row.getByTestId("sidebar-user-view-delete").click();
        await expect(
          page.getByTestId("sidebar-user-view").filter({ hasText: VIEW_NAME }),
        ).toHaveCount(0);
        await snap(page, testInfo, "削除後");
      });

      // Structural assertion: サイドバーのナビ構造(role と順序のみ)。プリセット
      // 2つ(高優先度 / 未対応のみ)がビュー節の先頭に並ぶ。作成したビューは
      // 削除済みなのでここには現れない。コピー・レイアウト変更に耐える。
      await expect(page.getByTestId("app-sidebar")).toMatchAriaSnapshot(`
      - link "Tickets"
      - link "Board"
      - link "高優先度"
      - link "未対応のみ"
    `);
    },
  );

  test(
    "an empty view name shows an error and never calls viewsCreate",
    {
      annotation: {
        type: "description",
        description:
          "priority フィルタ適用後、名前を空のまま確定すると view-error(role=alert)が「ビュー名を入力してください」で表示され、viewsCreate が一度も呼ばれない(クライアントで弾く)ことを検証",
      },
    },
    async ({ page }, testInfo) => {
      // viewsCreate が呼ばれたら記録する(空名はクライアントで弾かれ送信されない)。
      let createCalled = false;
      await page.route("**/api/rpc/tickets/viewsCreate", (route) => {
        createCalled = true;
        return route.fulfill({ json: { json: { error: "should not be called" } } });
      });

      await test.step("フィルタを適用して保存 UI を開く", async () => {
        await page.goto("/tickets?priority=high");
        await page.getByTestId("view-save").click();
        await expect(page.getByTestId("view-name-input")).toBeVisible();
        await snap(page, testInfo, "保存UI");
      });

      await test.step("空名のまま確定する", async () => {
        // 入力は空のまま確定ボタンを押す。
        await page.getByTestId("view-save-confirm").click();
      });

      await test.step("エラー表示と未送信を確認する", async () => {
        const error = page.getByTestId("view-error");
        await expect(error).toBeVisible();
        await expect(error).toHaveAttribute("role", "alert");
        await expect(error).toContainText("ビュー名を入力してください");
        // 入力 UI は開いたまま(未送信の証左)。
        await expect(page.getByTestId("view-name-input")).toBeVisible();
        expect(createCalled).toBe(false);
        await snap(page, testInfo, "空名エラー");
      });
    },
  );

  test.describe("customer session", () => {
    // 既定(agent)から seeded customer セッションへ opt-in(app-shell.spec.ts と同じ
    // storageState)。customer には saved-views 機能が一切見えない。
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "customer sees no view section and is forbidden from viewsCreate",
      {
        annotation: {
          type: "description",
          description:
            "顧客セッションで /tickets を開くとサイドバーにビュー節(sidebar-user-view)が1件も無く、request で viewsCreate を直 POST すると FORBIDDEN(403 相当のエラー封筒)で拒否されることを検証",
        },
      },
      async ({ page, request }, testInfo) => {
        await test.step("顧客としてチケット一覧を開く", async () => {
          await page.goto("/tickets");
          await expect(page.getByTestId("app-sidebar")).toBeVisible();
          await snap(page, testInfo, "顧客の一覧");
        });

        await test.step("サイドバーにビュー節が無いことを確認する", async () => {
          // ビュー節ごと出さない(spec: 既存 isAgent 出し分けの中)。
          await expect(page.getByTestId("sidebar-user-view")).toHaveCount(0);
          await snap(page, testInfo, "ビュー節なし");
        });

        await test.step("viewsCreate 直 POST が FORBIDDEN で拒否されることを確認する", async () => {
          // customer セッションのまま oRPC を直に叩く(UI を経由しない authz 検証)。
          // oRPC RPCHandler wire: body {"json": input}、失敗は 403 + code FORBIDDEN。
          const res = await request.post("/api/rpc/tickets/viewsCreate", {
            data: { json: { name: "customer view", filters: { status: "open" } } },
          });
          expect(res.status()).toBe(403);
          const body = (await res.json()) as { json?: { code?: string }; code?: string };
          const code = body.json?.code ?? body.code;
          expect(code).toBe("FORBIDDEN");
        });
      },
    );
  });
});
