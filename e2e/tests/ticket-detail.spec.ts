import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";
import pg from "pg";

// E2E for the ticket-detail feature (spec: specs/ticket-detail.md). Runs against
// the real oRPC routes over the deterministic postgres seed; the chromium
// project is authenticated as the seeded agent (playwright.config.ts), so a
// posted reply is authored by the agent. These verify UI plumbing only
// (open → thread → reply → append/clear, and the two handled failures), not
// message content quality.
test.describe("ticket-detail over oRPC @feature-ticket-detail", () => {
  test(
    "opens a ticket, reads the thread, and posts a reply @smoke",
    {
      annotation: {
        type: "description",
        description:
          "一覧からチケットを開いてシードの会話を読み、返信を投稿してスレッド末尾に自分の返信が追加され入力欄が空になるまでの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("一覧からチケットを開く", async () => {
        await page.goto("/tickets");
        await page
          .getByTestId("ticket-link")
          .filter({ hasText: "Cannot login to dashboard" })
          .click();
        await expect(page.getByTestId("ticket-subject")).toContainText("Cannot login to dashboard");
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("シードされたスレッドを読む", async () => {
        // 相対比較: 件数の絶対値ではなく「シード2件から返信で1件増える」ことを見る。
        await expect(page.getByTestId("message-item")).toHaveCount(2);
        await snap(page, testInfo, "スレッド");
      });

      await test.step("返信を投稿する", async () => {
        const before = await page.getByTestId("message-item").count();
        await page.getByLabel("Reply").fill("Thanks — I've reset your session, please retry.");
        await page.getByRole("button", { name: "Send reply" }).click();
        await expect(page.getByTestId("message-item")).toHaveCount(before + 1);
        await expect(page.getByTestId("message-item").last()).toContainText(
          "I've reset your session",
        );
        await expect(
          page.getByTestId("message-item").last().getByTestId("message-author"),
        ).toHaveText("agent@example.com");
        await expect(page.getByLabel("Reply")).toHaveValue("");
        await expect(page.getByTestId("reply-error")).toBeHidden();
        await snap(page, testInfo, "返信後");
      });

      // Structural assertion: the thread shell (subject, message list, reply
      // control) — roles and order only, survives copy and layout changes.
      await expect(page.getByTestId("message-thread")).toMatchAriaSnapshot(`
      - list:
        - listitem
        - listitem
        - listitem
    `);
    },
  );

  test(
    "shows a not-found panel for an unknown ticket id",
    {
      annotation: {
        type: "description",
        description:
          "存在しない id へ直接アクセスしたときにアプリが落ちず ticket-not-found を表示することを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("存在しないチケットへ直接アクセスする", async () => {
        await page.goto("/tickets/00000000-0000-7000-8000-0000000000ff");
      });

      await test.step("見つからないパネルを確認する", async () => {
        await expect(page.getByTestId("ticket-not-found")).toBeVisible();
        await expect(page.getByTestId("message-thread")).toBeHidden();
        await snap(page, testInfo, "不在チケット");
      });
    },
  );

  test(
    "rejects an empty reply and leaves the thread unchanged",
    {
      annotation: {
        type: "description",
        description:
          "空のまま Send reply したときに reply-error が出て、スレッドの件数が前後で変わらないことを検証",
      },
    },
    async ({ page }, testInfo) => {
      let before = 0;
      await test.step("チケットを開く", async () => {
        await page.goto("/tickets");
        await page.getByTestId("ticket-link").filter({ hasText: "Billing question" }).click();
        await expect(page.getByTestId("message-item").first()).toBeVisible();
        // 件数は絶対値でなく前後比較にする(実行順・並列度・他レーンの返信投稿に依存しない)。
        before = await page.getByTestId("message-item").count();
        await snap(page, testInfo, "詳細表示");
      });

      await test.step("空の返信を送信する", async () => {
        await page.getByRole("button", { name: "Send reply" }).click();
      });

      await test.step("返信エラー表示とスレッドが不変なことを確認する", async () => {
        await expect(page.getByTestId("reply-error")).toBeVisible();
        await expect(page.getByTestId("message-item")).toHaveCount(before);
        await snap(page, testInfo, "返信エラー");
      });
    },
  );
});

// 中断・破壊操作の固定(dev-cycle Phase 2.6、disruption-reviewer の反例と
// 頑健性確認から)。in-flight の窓は route.fetch() で「サーバ到達後・応答
// 未達」を決定的に固定し、サーバ状態は worker 専用 postgres へ直接
// count(*) で検証する(UI だけで判定しない — POLICY 共通規約)。

async function countBody(dbURL: string, body: string): Promise<number> {
  const client = new pg.Client({ connectionString: dbURL });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages WHERE body = $1",
      [body],
    );
    return rows[0].n;
  } finally {
    await client.end();
  }
}

const REPLY_ROUTE = "**/api/rpc/tickets/reply*";
const TICKET_1 = "00000000-0000-7000-8000-000000000001";

test.describe("disruption: reply の中断・破壊操作 @feature-ticket-detail", () => {
  test(
    "送信中(コミット後)リロード: 消失も二重もなくUIが整合する @disruption",
    {
      annotation: {
        type: "description",
        description:
          "返信の応答を route で握って「サーバはコミット済み・ブラウザは応答未達」の窓を固定し、その最中にリロードしても メッセージが1件だけ永続し、リロード後のスレッドに表示・入力欄は空・送信ボタンは enabled(スタックなし)であることを検証",
      },
    },
    async ({ page, workerStack }, testInfo) => {
      const body = `disruption reload ${testInfo.testId}`;
      await page.route(REPLY_ROUTE, async (route) => {
        const response = await route.fetch();
        await new Promise((r) => setTimeout(r, 3000));
        await route.fulfill({ response }).catch(() => {});
      });

      await page.goto(`/tickets/${TICKET_1}`);
      await page.getByLabel("Reply").fill(body);
      await page.getByRole("button", { name: "Send reply" }).click();
      await expect.poll(() => countBody(workerStack.dbURL, body)).toBe(1);
      await page.reload();

      await expect(page.getByTestId("message-item").filter({ hasText: body })).toHaveCount(1);
      await expect(page.getByLabel("Reply")).toHaveValue("");
      await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled();
      expect(await countBody(workerStack.dbURL, body)).toBe(1);
    },
  );

  test(
    "同期二連打でも返信は1件だけ永続する @disruption",
    {
      annotation: {
        type: "description",
        description:
          "反例の固定: pending 状態の伝播(disabled 化)より速い同一タスク内の同期2連 click では、フロントの isPending ガードを素通りして同一本文が2件永続した。onSubmit の同期 in-flight ガードにより DB・UI とも1件に留まることを検証",
      },
    },
    async ({ page, workerStack }, testInfo) => {
      const body = `disruption dblclick ${testInfo.testId}`;
      await page.goto(`/tickets/${TICKET_1}`);
      await page.getByLabel("Reply").fill(body);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          b.textContent?.includes("Send reply"),
        ) as HTMLButtonElement;
        btn.click();
        btn.click();
      });

      await expect.poll(() => countBody(workerStack.dbURL, body)).toBeGreaterThanOrEqual(1);
      await expect(page.getByTestId("message-item").filter({ hasText: body })).toHaveCount(1);
      expect(await countBody(workerStack.dbURL, body)).toBe(1);
    },
  );

  test(
    "オフライン送信は黙って保留せず、エラー表示と入力保持で失敗する @disruption",
    {
      annotation: {
        type: "description",
        description:
          "反例の固定: TanStack Query 既定の networkMode='online' ではオフライン送信が paused になり、エラーも送信中表示も出ないままタブを閉じると返信がサイレント消失した。networkMode='always' により即座に reply-error が表示され、入力が保持され、サーバに何も書かれないことを検証(復帰後に再送すれば1件で成功)",
      },
    },
    async ({ page, context, workerStack }, testInfo) => {
      const body = `disruption offline ${testInfo.testId}`;
      await page.goto(`/tickets/${TICKET_1}`);
      await page.getByLabel("Reply").fill(body);

      await context.setOffline(true);
      await page.getByRole("button", { name: "Send reply" }).click();
      await expect(page.getByTestId("reply-error")).toBeVisible();
      await expect(page.getByLabel("Reply")).toHaveValue(body);
      expect(await countBody(workerStack.dbURL, body)).toBe(0);

      // 復帰後の明示的な再送はそのまま成功する(自動再送はしない設計)。
      await context.setOffline(false);
      await page.getByRole("button", { name: "Send reply" }).click();
      await expect(page.getByTestId("message-item").filter({ hasText: body })).toHaveCount(1);
      expect(await countBody(workerStack.dbURL, body)).toBe(1);
    },
  );

  test(
    "送信中に打った続きの文は、送信成功でも消えない @disruption",
    {
      annotation: {
        type: "description",
        description:
          "反例の固定: onSuccess の無条件 setBody('') により、送信中に入力欄へ打った「次の文」が応答到着とともに消えていた(WS 先行反映で送信済みに見えるため窓は実質広い)。送信時点の本文と変わっていない場合だけクリアし、追記があれば保持されることを検証",
      },
    },
    async ({ page, workerStack }, testInfo) => {
      const first = `disruption typing ${testInfo.testId}`;
      await page.route(REPLY_ROUTE, async (route) => {
        const response = await route.fetch();
        await new Promise((r) => setTimeout(r, 2000));
        await route.fulfill({ response }).catch(() => {});
      });

      await page.goto(`/tickets/${TICKET_1}`);
      await page.getByLabel("Reply").fill(first);
      await page.getByRole("button", { name: "Send reply" }).click();
      await page.getByLabel("Reply").pressSequentially(" NEXT-THOUGHT");

      // onSuccess が走り切る(ボタン再有効化)まで待ってから入力を観測する。
      await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled({
        timeout: 10_000,
      });
      await expect(page.getByLabel("Reply")).toHaveValue(`${first} NEXT-THOUGHT`);
      expect(await countBody(workerStack.dbURL, first)).toBe(1);
    },
  );
});
