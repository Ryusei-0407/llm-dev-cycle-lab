import { expect, test } from "../fixtures";
import { apiLogin } from "../helpers/auth";
import { snap } from "../helpers/snap";

// E2E for the copilot feature (spec: specs/copilot.md E2E観点). A dock-type help
// bot, agent-only, mounted in AppShell so it survives route changes. These verify
// UI plumbing only (launch → 送信 → ストリーミング表示 → SUP-n ジャンプ / 失敗表示 /
// customer の出し分け + 直POST 403), not answer quality — role と順序でアサートする。
//
// 主経路は実バックエンド(既定のモック provider)を使う: プロンプトに <<<STATS>>> を
// 含む copilot リクエストへ、MockProvider が固定文を返す(specs/copilot.md「MockProvider
// の拡張」)。その固定文は SUP-1 参照を含み、copilot-ref のクリック先(SUP-1 = Cannot
// login to dashboard)へジャンプする主経路のアンカーになる。失敗系のみ page.route で
// /api/copilot/chat を 500 に差し替える(UI の error 分岐だけを決定論的に見る)。
//
// MockProvider の固定文(完全一致・specs/copilot.md)。
const FIXED_LINE =
  "現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。";
const QUESTION = "全体のチケットの進行状況は?";
// SUP-1 のシード件名(copilot-ref のジャンプ先確認に使う)。
const SUP1_SUBJECT = "Cannot login to dashboard";

test.describe("copilot dock @feature-copilot", () => {
  test(
    "agent asks copilot and jumps to a referenced ticket @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者がサイドバーの copilot-launch でパネル(copilot-panel)を開き、『全体のチケットの進行状況は?』を送信すると copilot-user に質問が出て copilot-assistant に MockProvider の固定文がストリーミング表示され、文中の SUP-1(copilot-ref)をクリックすると SUP-1 詳細(ticket-subject = Cannot login to dashboard)へ遷移し、パネルは開いたままである主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("Copilot ドックを開く", async () => {
        await page.goto("/tickets");
        await page.getByTestId("copilot-launch").click();
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await snap(page, testInfo, "Copilot を開く");
      });

      await test.step("質問を送信する", async () => {
        await page.getByTestId("copilot-input").fill(QUESTION);
        await page.getByTestId("copilot-send").click();
        // ユーザー発話がリストに現れる。
        await expect(page.getByTestId("copilot-user")).toContainText(QUESTION);
        await snap(page, testInfo, "質問を送信");
      });

      await test.step("固定文がストリーミング表示される", async () => {
        // 固定待ちは使わず、固定文テキストの出現で完了を待つ(SSE 逐次表示)。
        await expect(page.getByTestId("copilot-assistant")).toContainText(FIXED_LINE);
        await expect(page.getByTestId("copilot-error")).toHaveCount(0);
        await snap(page, testInfo, "回答表示");
      });

      await test.step("SUP-1 参照をクリックして詳細へジャンプする", async () => {
        // 固定文中の SUP-1 は copilot-ref リンクとして描画される。部分一致の多重
        // マッチを避け、SUP-1 を持つ ref を一意に絞る。
        const ref = page.getByTestId("copilot-ref").filter({ hasText: "SUP-1" });
        await expect(ref).toBeVisible();
        await ref.click();
        await expect(page.getByTestId("ticket-subject")).toContainText(SUP1_SUBJECT);
        await expect(page).toHaveURL(/\/tickets\//);
        // ドックは AppShell 直下なのでルート遷移後も開いたまま。
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await snap(page, testInfo, "SUP-1 へ遷移");
      });

      // 構造アサーション: 回答本文の散文は変わりうるので、ドックの骨格(入力・送信の
      // role と順序)だけを固定する。ローカルは ignoreSnapshots で aria も
      // スキップされるため、可視性は上の toBeVisible で別途担保済み。
      await expect(page.getByTestId("copilot-panel")).toMatchAriaSnapshot(`
        - textbox
        - button
      `);
    },
  );

  test(
    "shows a copilot error when the API returns 500",
    {
      annotation: {
        type: "description",
        description:
          "copilot chat のリクエストが 500 を返したとき copilot-error(『回答の取得に失敗しました。』)が表示されることを検証(UI の失敗分岐)",
      },
    },
    async ({ page }, testInfo) => {
      await page.route("**/api/copilot/chat", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        }),
      );

      await test.step("Copilot を開いて質問する", async () => {
        await page.goto("/tickets");
        await page.getByTestId("copilot-launch").click();
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await page.getByTestId("copilot-input").fill(QUESTION);
        await page.getByTestId("copilot-send").click();
        await snap(page, testInfo, "失敗する送信");
      });

      await test.step("エラー表示を確認する", async () => {
        await expect(page.getByTestId("copilot-error")).toBeVisible();
        await expect(page.getByTestId("copilot-error")).toContainText("回答の取得に失敗しました。");
        await snap(page, testInfo, "エラー表示");
      });
    },
  );

  test.describe("customer session", () => {
    // 顧客セッションに opt-in(project 既定は agent)。app-shell / customer-portal
    // spec と同じ storageState(setup 生成の e2e/.auth/customer.json)。
    test.use({ storageState: "e2e/.auth/customer.json" });

    test(
      "customer has no copilot launcher and is forbidden from the endpoint",
      {
        annotation: {
          type: "description",
          description:
            "顧客セッションではサイドバーに copilot-launch が無く、さらに request で /api/copilot/chat を顧客セッションのまま直接 POST すると HTTP 403 で拒否されることを検証(agent 専用の出し分けとエンドポイント認可)",
        },
      },
      async ({ page, request }, testInfo) => {
        await test.step("顧客サイドバーに copilot-launch が無い", async () => {
          await page.goto("/tickets");
          await expect(page.getByTestId("app-sidebar")).toBeVisible();
          await expect(page.getByTestId("copilot-launch")).toHaveCount(0);
          await snap(page, testInfo, "顧客に launcher 無し");
        });

        await test.step("顧客セッションの直POSTは 403", async () => {
          // page と同じ顧客セッションを request コンテキストにも確立してから直接叩く。
          await apiLogin(request, "customer");
          const res = await request.post("/api/copilot/chat", {
            data: { messages: [{ role: "user", content: QUESTION }] },
          });
          expect(res.status()).toBe(403);
        });
      },
    );
  });
});
