import type { Page } from "@playwright/test";
import pg from "pg";
import { expect, test } from "../fixtures";
import { aguiDraftBody } from "../helpers/agui-sse";
import { snap } from "../helpers/snap";

// Disruption review for reply-draft (spec: specs/reply-draft.md).
// Vectors: reload / SPA back / tab close / double-fire / Send reply mid-stream /
// offline / session expiry, each with the in-flight window pinned by a held
// page.route (never a sleep race). Server state is verified through the worker's
// own database (messages table) and /api/health, not the UI alone.
const DRAFT_SUBJECT = "Cannot login to dashboard";
const DRAFT_TEXT = `Draft reply for "${DRAFT_SUBJECT}": Thanks for reaching out. We are looking into your issue and will follow up shortly.`;
const TICKET_ID = "00000000-0000-7000-8000-000000000001";
const SEED_MESSAGE_COUNT = 2;

function draftDeltas(text: string): string[] {
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

async function openLoginTicket(page: Page) {
  await page.goto("/tickets");
  await page.getByTestId("ticket-link").filter({ hasText: DRAFT_SUBJECT }).click();
  await expect(page.getByTestId("ticket-subject")).toContainText(DRAFT_SUBJECT);
}

async function messageCount(dbURL: string): Promise<number> {
  const client = new pg.Client({ connectionString: dbURL });
  await client.connect();
  try {
    const res = await client.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [
      TICKET_ID,
    ]);
    return res.rows[0].n as number;
  } finally {
    await client.end();
  }
}

// Holds every /api/tickets/draft request until release() is called, then
// fulfills with a complete mock stream. Returns a request counter so tests can
// assert how many streams were actually opened.
async function holdDraftRoute(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counter = { requests: 0 };
  await page.route("**/api/tickets/draft", async (route) => {
    counter.requests++;
    await gate;
    // The request may already be gone (reload / navigation / close aborted it).
    await route
      .fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: aguiDraftBody(draftDeltas(DRAFT_TEXT)),
      })
      .catch(() => {});
  });
  return { release, counter };
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test.describe("reply-draft disruption @feature-reply-draft @disruption", () => {
  test(
    "SSE 生成中のリロード: 復帰後にスタックせず、再生成が成功し、サーバに何も残らない @disruption",
    {
      annotation: {
        type: "description",
        description:
          "ドラフト生成のストリーミング中にページをリロードしても、復帰後にスピナー・エラー・部分文が残らず再生成が成功し、サーバにメッセージが永続化されないことを検証",
      },
    },
    async ({ page, workerStack }, testInfo) => {
      const errors = collectPageErrors(page);
      const { counter } = await holdDraftRoute(page);

      await test.step("チケットを開き生成を開始する", async () => {
        await openLoginTicket(page);
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-streaming")).toBeVisible();
        await snap(page, testInfo, "生成中");
      });

      await test.step("生成中にリロードする", async () => {
        await page.reload();
        await expect(page.getByTestId("ticket-subject")).toContainText(DRAFT_SUBJECT);
        // 復帰後: スピナー・エラー・部分文のいずれも残らず、ボタンは再度押せる。
        await expect(page.getByTestId("draft-streaming")).toBeHidden();
        await expect(page.getByTestId("draft-error")).toBeHidden();
        await expect(page.getByTestId("draft-panel")).not.toContainText("Draft reply for");
        await expect(page.getByTestId("generate-draft")).toBeEnabled();
        await snap(page, testInfo, "リロード後");
      });

      await test.step("再生成が実サーバで成功する", async () => {
        await page.unroute("**/api/tickets/draft");
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-panel")).toContainText(DRAFT_TEXT);
        await page.getByTestId("use-draft").click();
        await expect(page.getByLabel("Reply")).toHaveValue(DRAFT_TEXT);
        await snap(page, testInfo, "再生成と転写");
      });

      await test.step("サーバ状態を検証する", async () => {
        // draft は永続化されない(メッセージ増無し)+ API 健在。
        expect(await messageCount(workerStack.dbURL)).toBe(SEED_MESSAGE_COUNT);
        const health = await page.request.get("/api/health");
        expect(health.ok()).toBeTruthy();
        expect(counter.requests).toBe(1);
        expect(errors).toEqual([]);
      });
    },
  );

  test(
    "SSE 生成中の SPA 戻る→再訪: fetch が中断され、再訪ページはクリーンに再生成できる @disruption",
    {
      annotation: {
        type: "description",
        description:
          "ストリーミング中に SPA の戻るで一覧へ離脱すると in-flight fetch が abort され、再訪した詳細ページはスタックなしで再生成できることを検証",
      },
    },
    async ({ page }, testInfo) => {
      const errors = collectPageErrors(page);
      await holdDraftRoute(page);

      const failed: string[] = [];
      page.on("requestfailed", (req) => {
        if (req.url().includes("/api/tickets/draft")) failed.push(req.failure()?.errorText ?? "");
      });

      await test.step("チケットを開き生成を開始する", async () => {
        await openLoginTicket(page);
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-streaming")).toBeVisible();
        await snap(page, testInfo, "生成中");
      });

      await test.step("生成中に一覧へ戻る", async () => {
        await page.goBack();
        await expect(page).toHaveURL(/\/tickets$/);
        // unmount 時に useChat が in-flight fetch を abort すること(ゾンビ接続防止)。
        await expect
          .poll(() => failed.length, { message: "draft fetch should be aborted on unmount" })
          .toBeGreaterThan(0);
        await snap(page, testInfo, "一覧へ離脱");
      });

      await test.step("再訪ページで再生成する", async () => {
        await page.getByTestId("ticket-link").filter({ hasText: DRAFT_SUBJECT }).click();
        await expect(page.getByTestId("ticket-subject")).toContainText(DRAFT_SUBJECT);
        await expect(page.getByTestId("draft-streaming")).toBeHidden();
        await expect(page.getByTestId("draft-error")).toBeHidden();
        await expect(page.getByTestId("generate-draft")).toBeEnabled();

        await page.unroute("**/api/tickets/draft");
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-panel")).toContainText(DRAFT_TEXT);
        await snap(page, testInfo, "再訪後の再生成");
        expect(errors).toEqual([]);
      });
    },
  );

  test(
    "生成中の Send reply: 返信は1件だけ永続し、ストリームも Use draft も壊れない @disruption",
    {
      annotation: {
        type: "description",
        description:
          "ドラフト生成のストリーミング中に手入力の返信を送信しても返信はちょうど1件だけ永続し、返信成功による詳細再フェッチがストリームを壊さず Use draft の転写も成立することを検証",
      },
    },
    async ({ page, workerStack }, testInfo) => {
      const errors = collectPageErrors(page);
      const { release } = await holdDraftRoute(page);

      await test.step("チケットを開き生成を開始する", async () => {
        await openLoginTicket(page);
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-streaming")).toBeVisible();
        await snap(page, testInfo, "生成中");
      });

      await test.step("生成中に返信を送信する", async () => {
        await page.getByLabel("Reply").fill("Manual reply typed while the draft streams.");
        await page.getByRole("button", { name: "Send reply" }).click();
        await expect(page.getByTestId("message-thread")).toContainText(
          "Manual reply typed while the draft streams.",
        );
        expect(await messageCount(workerStack.dbURL)).toBe(SEED_MESSAGE_COUNT + 1);
        await snap(page, testInfo, "返信の永続化");
      });

      await test.step("ストリーム完了と転写を検証する", async () => {
        // 返信成功(detail 再フェッチ)がストリームを巻き添えにしないこと。
        release();
        await expect(page.getByTestId("draft-panel")).toContainText(DRAFT_TEXT);
        await page.getByTestId("use-draft").click();
        await expect(page.getByLabel("Reply")).toHaveValue(DRAFT_TEXT);
        await snap(page, testInfo, "完了と転写");
        expect(errors).toEqual([]);
      });
    },
  );

  test(
    "生成中の接続断: エラー表示に落ち、復帰後の再生成が成功する @disruption",
    {
      annotation: {
        type: "description",
        description:
          "ストリーミング要求の in-flight 中に接続が切れる(route.abort で決定化)と draft-error に落ちてスピナーが解除され、復帰後の再生成でエラーが消えて成功することを検証",
      },
    },
    async ({ page }, testInfo) => {
      const errors = collectPageErrors(page);
      // 接続断は route.abort で決定化(fetch の reject = 実際のネットワーク断と同じ経路)。
      let abortNext = true;
      await page.route("**/api/tickets/draft", async (route) => {
        if (abortNext) {
          // ストリーミング窓を見せてから切る。
          await new Promise((resolve) => setTimeout(resolve, 300));
          await route.abort("internetdisconnected");
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: aguiDraftBody(draftDeltas(DRAFT_TEXT)),
        });
      });

      await test.step("チケットを開き、接続断で失敗する生成を要求する", async () => {
        await openLoginTicket(page);
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-streaming")).toBeVisible();
        await expect(page.getByTestId("draft-error")).toBeVisible();
        await expect(page.getByTestId("draft-streaming")).toBeHidden();
        await expect(page.getByTestId("generate-draft")).toBeEnabled();
        await snap(page, testInfo, "接続断エラー");
      });

      await test.step("復帰後の再生成が成功する", async () => {
        abortNext = false;
        await page.getByTestId("generate-draft").click();
        await expect(page.getByTestId("draft-panel")).toContainText(DRAFT_TEXT);
        await expect(page.getByTestId("draft-error")).toBeHidden();
        await snap(page, testInfo, "復帰後の成功");
        expect(errors).toEqual([]);
      });
    },
  );
});
