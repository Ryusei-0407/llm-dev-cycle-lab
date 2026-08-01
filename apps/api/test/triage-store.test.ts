import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// triage extends the ticket store (spec: specs/triage.md unit観点). listPage
// gains server-side filters (status / priority / label / unassigned / unresolved)
// that AND together and compose with the keyset cursor + role scope, and the
// store gains inboxCount() (assignee_email IS NULL AND status <> 'resolved').
// These shapes are the spec's contract; the new input fields / method do not
// exist yet in this branch (RED). db.ts holds the connection helper, store.ts
// exposes createTicketStore(pool) + a named NotFoundError.
//
// Assumed public shapes (spec 由来, fixed by this RED — the existing app-shell /
// ticket-model listPage already returns { items, nextCursor }):
//   listPage(input) → { items: Ticket[]; nextCursor: string | null }
//     input: { cursor?, limit?, status?, priority?, label?, unassigned?,
//              unresolved?, scope?: { requesterEmail } }
//   inboxCount() → number
// Role scope is threaded as input.scope.requesterEmail (the router derives it
// from the session, mirroring how list()'s scope is applied at the procedure
// boundary in authz.test.ts). Filters live in the store because the spec pins
// them as unit観点 ("store.listPage フィルタ").
import { createPool } from "../src/db.js";
import { createTicketStore, type ListPageArgs } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed
// seeds — the idempotent reset the store lane leans on for per-test isolation.
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// Connection comes from the vitest globalSetup (apps/api/test/global-setup.ts).
// Never hardcode a connection string here — POLICY.md §共通規約.
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

// Fixed seed state (apps/api/db/seed.sql + specs/ticket-model.md シード):
//   1 "Cannot login to dashboard" open        high   auth    未割り当て
//   2 "Billing question"          in_progress medium billing agent@ 割り当て済み
//   3 "Feature request: dark mode" resolved    low    request 未割り当て
// → inbox(未割り当て かつ 非 resolved)に入るのはシード1のみ = inboxCount 1。
const LOGIN = "Cannot login to dashboard";
const BILLING = "Billing question";
const FEATURE = "Feature request: dark mode";
const CUSTOMER_EMAIL = "customer@example.com";

type PageItem = { id: string; subject: string; status: string };

describe("triage store: listPage フィルタ @feature-triage", () => {
  let pool: Pool;
  let store: ReturnType<typeof createTicketStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createTicketStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  async function subjectsOf(input: Record<string, unknown>): Promise<string[]> {
    const page = (await store.listPage({ limit: 100, ...input })) as {
      items: Array<{ subject: string }>;
    };
    return page.items.map((t) => t.subject);
  }

  it(
    "status フィルタ単独: open のみを返す(in_progress/resolved を除外)",
    {
      annotation: {
        type: "description",
        description:
          "listPage に status=open を渡すと open のシード(Cannot login)だけが返り、in_progress(Billing)・resolved(Feature)が除外されることを検証(status フィルタ単独)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ status: "open" });
      expect(subjects).toContain(LOGIN);
      expect(subjects).not.toContain(BILLING);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "priority フィルタ単独: high のみを返す(medium/low を除外)",
    {
      annotation: {
        type: "description",
        description:
          "listPage に priority=high を渡すと high のシード(Cannot login)だけが返り、medium(Billing)・low(Feature)が除外されることを検証(priority フィルタ単独)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ priority: "high" });
      expect(subjects).toContain(LOGIN);
      expect(subjects).not.toContain(BILLING);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "label フィルタ単独: billing 付与のチケットのみを返す",
    {
      annotation: {
        type: "description",
        description:
          "listPage に label=billing を渡すと billing ラベル付きのシード(Billing question)だけが返り、auth(Cannot login)・request(Feature)が除外されることを検証(EXISTS(ticket_labels⋈labels) 相当)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ label: "billing" });
      expect(subjects).toContain(BILLING);
      expect(subjects).not.toContain(LOGIN);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "unassigned フィルタ単独: 未割り当て(assignee_email IS NULL)のみを返す",
    {
      annotation: {
        type: "description",
        description:
          "listPage に unassigned=true を渡すと未割り当てのシード(Cannot login / Feature)が返り、agent 割り当て済み(Billing)が除外されることを検証(assignee_email IS NULL)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ unassigned: true });
      expect(subjects).toContain(LOGIN);
      expect(subjects).toContain(FEATURE);
      expect(subjects).not.toContain(BILLING);
    },
  );

  it(
    "unresolved フィルタ単独: status <> resolved のみを返す",
    {
      annotation: {
        type: "description",
        description:
          "listPage に unresolved=true を渡すと非 resolved のシード(Cannot login / Billing)が返り、resolved(Feature)が除外されることを検証(inboxCount と同じ述語を一覧でも使う)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ unresolved: true });
      expect(subjects).toContain(LOGIN);
      expect(subjects).toContain(BILLING);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "unassigned + unresolved の AND 結合: 受信トレイの中身(Cannot login のみ)",
    {
      annotation: {
        type: "description",
        description:
          "listPage に unassigned=true かつ unresolved=true を渡すと AND 結合され、未割り当てかつ非 resolved のシード(Cannot login)だけが返り、割り当て済み(Billing)・resolved(Feature)が除外されることを検証(inbox の取得条件)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ unassigned: true, unresolved: true });
      expect(subjects).toContain(LOGIN);
      expect(subjects).not.toContain(BILLING);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "未知の label 名は空結果(エラーにしない)",
    {
      annotation: {
        type: "description",
        description:
          "カタログに存在しない label 名を listPage に渡すと throw せず空の items を返すことを検証(仕様: カタログに無い name は空結果)",
      },
    },
    async () => {
      const page = (await store.listPage({ limit: 100, label: "does-not-exist" })) as {
        items: unknown[];
      };
      expect(page.items).toEqual([]);
    },
  );

  it(
    "フィルタはカーソルと併用でき、フィルタ付き2ページ目が重複なく続く",
    {
      annotation: {
        type: "description",
        description:
          "unresolved=true(2件が該当)で limit=1・カーソル送りページングすると、各ページの subject を連結した列が unresolved 一括取得の順序と一致し、重複や欠落が無いことを検証(フィルタ + keyset カーソル併用)",
      },
    },
    async () => {
      const all = await subjectsOf({ unresolved: true });
      // フィルタが実際に効いていること(resolved を除外)をアンカーする。ここが
      // 無いと、フィルタ未実装で全件返っても「一括取得列とページング列が一致」で
      // 通ってしまう(RED を成立させる本質)。
      expect(all).toContain(LOGIN);
      expect(all).toContain(BILLING);
      expect(all).not.toContain(FEATURE);
      expect(all.length).toBeGreaterThanOrEqual(2);

      const collected: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard <= all.length + 1; guard++) {
        const input: ListPageArgs = { limit: 1, unresolved: true };
        if (cursor) input.cursor = cursor;
        const page = (await store.listPage(input)) as {
          items: PageItem[];
          nextCursor: string | null;
        };
        for (const t of page.items) collected.push(t.subject);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBe(null);
      // ページング列も resolved を含まない(フィルタがページ境界を跨いで効く)。
      expect(collected).not.toContain(FEATURE);
      expect(collected).toEqual(all);
    },
  );

  it(
    "customer ロールスコープとフィルタの併用: 自分所有の中で priority=high のみ",
    {
      annotation: {
        type: "description",
        description:
          "scope.requesterEmail=customer と priority=high を併用すると、返る items がすべて customer 所有かつ high(Cannot login)で、他条件が AND 結合されることを検証(スコープ + フィルタの両立)",
      },
    },
    async () => {
      // スコープ検証を空虚にしない: 全シードが customer 所有のため、agent 所有の
      // high チケットを1件作り「スコープで除外されること」を実際に観測する。
      const agentOwned = "Agent-owned high (scope check)";
      await store.create({
        subject: agentOwned,
        priority: "high",
        requesterEmail: "agent@example.com",
      });
      const page = (await store.listPage({
        limit: 100,
        priority: "high",
        requesterEmail: CUSTOMER_EMAIL,
      })) as { items: Array<{ subject: string; requesterEmail: string }> };
      const subjects = page.items.map((t) => t.subject);
      expect(subjects).toContain(LOGIN);
      expect(subjects).not.toContain(agentOwned);
      // priority フィルタが scope と AND で効いていること: high 以外の自分所有行
      // (Billing=medium / Feature=low)は除外される。これが無いとフィルタ未実装でも
      // 「全て customer 所有」だけで通ってしまう。
      expect(subjects).not.toContain(BILLING);
      expect(subjects).not.toContain(FEATURE);
      for (const t of page.items) {
        expect(t.requesterEmail).toBe(CUSTOMER_EMAIL);
      }
    },
  );
});

describe("triage store: inboxCount @feature-triage", () => {
  let pool: Pool;
  let store: ReturnType<typeof createTicketStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createTicketStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "inboxCount はシード直後 1(未割り当て かつ 非 resolved のシード1のみ)",
    {
      annotation: {
        type: "description",
        description:
          "applySchemaAndSeed 直後の inboxCount が、未割り当てかつ非 resolved のシード(Cannot login)1件ぶんの 1 を返すことを検証(定義: assignee_email IS NULL AND status <> 'resolved')",
      },
    },
    async () => {
      expect(await store.inboxCount()).toBe(1);
    },
  );

  it(
    "割り当てると inboxCount が減る(相対検証)",
    {
      annotation: {
        type: "description",
        description:
          "受信トレイ対象のチケット(Cannot login)を agent に setAssignee すると、その前後で inboxCount が 1 減ることを検証(絶対数でなく割り当てによる減少をアンカー)",
      },
    },
    async () => {
      const target = (await store.list()).find((t) => t.subject === LOGIN)!;
      const before = await store.inboxCount();
      await store.setAssignee(target.id, "agent@example.com");
      const after = await store.inboxCount();
      expect(after).toBe(before - 1);
    },
  );

  it(
    "resolved にすると inboxCount が減る(解決済みはトリアージ不要)",
    {
      annotation: {
        type: "description",
        description:
          "受信トレイ対象のチケット(Cannot login)を resolved に setStatus すると inboxCount が 1 減ることを検証(status <> 'resolved' 述語が効いている)",
      },
    },
    async () => {
      const target = (await store.list()).find((t) => t.subject === LOGIN)!;
      const before = await store.inboxCount();
      await store.setStatus(target.id, "resolved");
      const after = await store.inboxCount();
      expect(after).toBe(before - 1);
    },
  );
});
