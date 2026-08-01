import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";
import { apiLogin } from "../helpers/auth";
import { snap } from "../helpers/snap";

// E2E for the command-palette feature (spec: specs/command-palette.md E2E観点).
// A ⌘K / Ctrl+K palette mounted once in AppShell (認証後全画面) provides nav
// jumps and ticket search (tickets.search) — SUP-n / subject 断片からチケットへ。
// These verify plumbing only (開く → 検索 → 選択で遷移 → 閉じる / 番号検索と該当なし /
// customer の出し分けとスコープ), not content — role と順序でアサートする。
// キーボードは CI(linux)基準で page.keyboard.press("Control+k") を使う。
//
// Lanes:
// - @smoke(実バックエンド・agent): /tickets で Ctrl+K → palette-input フォーカス →
//   "Billing" で palette-ticket に SUP-2 / Billing question → クリックで詳細へ →
//   再度 Ctrl+K → palette-nav-board で /board へ。
// - 番号検索と該当なし(agent): "SUP-1" で Cannot login 行 → 該当なし語で palette-empty →
//   Esc で palette 不可視。
// - customer(入れ子 describe でセッション切替): nav-board / nav-inbox 不在・
//   nav-tickets 在。agent 所有チケットの件名で検索してもヒットしない(スコープ)・
//   自分のシード件名ではヒットする。
test.describe("command-palette @feature-command-palette", () => {
  test(
    "agent opens the palette, searches a ticket, and navigates @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が /tickets で Ctrl+K を押すとコマンドパレット(command-palette)が開いて palette-input にフォーカスが入り、'Billing' と入力すると palette-ticket 行に SUP-2 と Billing question が出て、クリックで /tickets 詳細(ticket-subject = Billing question)へ遷移しパレットが閉じ、再度 Ctrl+K で palette-nav-board を選ぶと /board(kanban-column-open 可視)へ遷移する主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("チケット一覧で Ctrl+K を押しパレットを開く", async () => {
        await page.goto("/tickets");
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        // 開いたら自動フォーカス。focus は aria snapshot に出ないので明示的に見る。
        await expect(page.getByTestId("palette-input")).toBeFocused();
        await snap(page, testInfo, "パレットを開く");
      });

      await test.step("Billing で検索しチケット行が出る", async () => {
        await page.getByTestId("palette-input").fill("Billing");
        // 部分一致 hasText の多重マッチを避けるため、SUP-2 のシード行を subject で
        // 一意に絞る(seed 内で Billing question は一意)。
        const row = page.getByTestId("palette-ticket").filter({ hasText: "Billing question" });
        await expect(row).toBeVisible();
        await expect(row).toContainText("SUP-2");
        await snap(page, testInfo, "チケット検索ヒット");
      });

      await test.step("チケット行クリックで詳細へ遷移しパレットが閉じる", async () => {
        await page.getByTestId("palette-ticket").filter({ hasText: "Billing question" }).click();
        await expect(page.getByTestId("ticket-subject")).toHaveText("Billing question");
        await expect(page).toHaveURL(/\/tickets\//);
        // 選択でパレットは閉じる。
        await expect(page.getByTestId("command-palette")).toBeHidden();
        await snap(page, testInfo, "詳細へ遷移");
      });

      await test.step("再度 Ctrl+K → Board へナビゲートする", async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await page.getByTestId("palette-nav-board").click();
        await expect(page).toHaveURL(/\/board$/);
        await expect(page.getByTestId("kanban-column-open")).toBeVisible();
        await expect(page.getByTestId("command-palette")).toBeHidden();
        await snap(page, testInfo, "Board へ遷移");
      });

      // Structural assertion: パレットの骨格(検索入力とナビゲーション項目の
      // role と順序のみ)。空検索でもナビは出るので、開いた直後の骨格を固定する。
      // aria snapshot は不在でも通りうるため上で toBeVisible / toBeFocused 済み。
      await test.step("パレットの構造(role と順序)を固定する", async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await expect(page.getByTestId("command-palette")).toMatchAriaSnapshot(`
          - dialog:
            - textbox
            - option "受信トレイ"
            - option "Tickets"
            - option "Board"
        `);
        await snap(page, testInfo, "パレット構造");
      });
    },
  );

  test(
    "number search hits and a no-match query shows the empty state",
    {
      annotation: {
        type: "description",
        description:
          "担当者が Ctrl+K で 'SUP-1' と入力すると Cannot login to dashboard の palette-ticket 行が出て(番号完全一致)、入力を該当なし語(zzz-no-match-zzz)に変えると palette-empty(該当なし)が表示され、Esc でパレットが閉じて command-palette が不可視になることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("パレットを開き番号 SUP-1 で検索する", async () => {
        await page.goto("/tickets");
        await page.keyboard.press("Control+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await page.getByTestId("palette-input").fill("SUP-1");
        // seed の SUP-1 は Cannot login to dashboard。subject で一意に絞る。
        await expect(
          page.getByTestId("palette-ticket").filter({ hasText: "Cannot login to dashboard" }),
        ).toBeVisible();
        await snap(page, testInfo, "番号検索ヒット");
      });

      await test.step("該当なし語に変えると empty 表示になる", async () => {
        await page.getByTestId("palette-input").fill("zzz-no-match-zzz");
        await expect(page.getByTestId("palette-empty")).toBeVisible();
        // 検索結果 0 件なのでチケット行は消える。
        await expect(page.getByTestId("palette-ticket")).toHaveCount(0);
        await snap(page, testInfo, "該当なし");
      });

      await test.step("Esc でパレットが閉じる", async () => {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("command-palette")).toBeHidden();
        await snap(page, testInfo, "Esc で閉じる");
      });
    },
  );

  test.describe("customer session", () => {
    // 顧客セッションに opt-in(project 既定は agent)。app-shell / customer-portal
    // spec と同じ storageState(setup 生成の e2e/.auth/customer.json)。
    test.use({ storageState: "e2e/.auth/customer.json" });

    // Creates a ticket owned by the *agent* over the oRPC wire, so the customer
    // スコープ検証に決定論的なターゲットを与える(共有シードを汚さない)。
    // apiLogin は request コンテキストの cookie を agent に差し替える。page 自身は
    // customer.json の storageState を使うため、page の customer セッションは不変。
    async function createAgentTicket(request: APIRequestContext, subject: string): Promise<void> {
      await apiLogin(request, "agent");
      const res = await request.post("/api/rpc/tickets/create", {
        data: { json: { subject, priority: "medium" } },
      });
      expect(res.ok(), `create expected 2xx, got ${res.status()}`).toBeTruthy();
    }

    test(
      "customer palette hides agent-only nav and never leaks agent tickets",
      {
        annotation: {
          type: "description",
          description:
            "顧客セッションのパレットには palette-nav-board / palette-nav-inbox が無く palette-nav-tickets はあり、さらに agent が作成したチケットの件名で検索しても palette-ticket に混入せず(ロールスコープ)、自分のシード件名(Billing question)では palette-ticket にヒットすることを検証",
        },
      },
      async ({ page, request }, testInfo) => {
        const agentSubject = "Palette scope leak check (agent-owned)";

        await test.step("スコープ検証用に agent 所有チケットをAPIで用意する", async () => {
          await createAgentTicket(request, agentSubject);
        });

        await test.step("顧客でパレットを開きナビの出し分けを確認する", async () => {
          await page.goto("/tickets");
          await page.keyboard.press("Control+k");
          await expect(page.getByTestId("command-palette")).toBeVisible();
          // agent 専用ナビは不在、共通の Tickets は在る。
          await expect(page.getByTestId("palette-nav-tickets")).toBeVisible();
          await expect(page.getByTestId("palette-nav-board")).toHaveCount(0);
          await expect(page.getByTestId("palette-nav-inbox")).toHaveCount(0);
          await snap(page, testInfo, "顧客ナビ出し分け");
        });

        await test.step("agent 所有件名で検索しても混入しない", async () => {
          await page.getByTestId("palette-input").fill(agentSubject);
          await expect(
            page.getByTestId("palette-ticket").filter({ hasText: agentSubject }),
          ).toHaveCount(0);
          // 検索が空振りしているだけでないことの担保: 0 件表示(empty)が出る。
          await expect(page.getByTestId("palette-empty")).toBeVisible();
          await snap(page, testInfo, "agent 件名は混入しない");
        });

        await test.step("自分のシード件名ではヒットする", async () => {
          await page.getByTestId("palette-input").fill("Billing question");
          await expect(
            page.getByTestId("palette-ticket").filter({ hasText: "Billing question" }),
          ).toBeVisible();
          await snap(page, testInfo, "自分の件名はヒット");
        });
      },
    );
  });
});
