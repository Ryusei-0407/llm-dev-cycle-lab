import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// command-palette adds a single store method: search (spec: specs/command-palette.md
// unit観点). The store gains store.search({ q, requesterEmail? }) → Ticket[]:
//   - q が /^(?:SUP-)?(\d+)$/i にマッチ → number 完全一致(SUP-12 と 12 は共に number=12)
//   - それ以外 → subject の部分一致(大文字小文字を区別しない ILIKE)。% _ はリテラル扱い
//   - 最大 20 件、並びは created_at DESC, id DESC(既存 list と同じ順序契約)
//   - スコープは list と同一(requesterEmail が渡ると自分所有のみ)
//   - 該当なしは空配列(throw しない)
// The search method does not exist yet in this branch (RED). db.ts holds the
// connection helper, store.ts exposes createTicketStore(pool)。
import { createPool } from "../src/db.js";
import { createTicketStore, type SearchArgs } from "../src/tickets/store.js";
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

// Fixed seed state (apps/api/db/seed.sql + specs/ticket-model.md シード)。すべて
// customer@example.com 所有。number は seed 挿入順で 1..3(SUP-1..3)。
//   1 "Cannot login to dashboard"   open        high   auth
//   2 "Billing question"            in_progress medium billing
//   3 "Feature request: dark mode"  resolved    low    request
const LOGIN = "Cannot login to dashboard";
const BILLING = "Billing question";
const FEATURE = "Feature request: dark mode";
const CUSTOMER_EMAIL = "customer@example.com";
const AGENT_EMAIL = "agent@example.com";

describe("command-palette store.search @feature-command-palette", () => {
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

  async function subjectsOf(input: SearchArgs): Promise<string[]> {
    const rows = (await store.search(input)) as Array<{ subject: string }>;
    return rows.map((t) => t.subject);
  }

  it(
    "subject 部分一致は大文字小文字を区別しない(ILIKE)",
    {
      annotation: {
        type: "description",
        description:
          "q='billing'(小文字)で search すると subject に Billing を含むシード(Billing question)がヒットし、他のシード(Cannot login / Feature)は返らないことを検証(subject の大文字小文字非区別の部分一致)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ q: "billing" });
      expect(subjects).toContain(BILLING);
      expect(subjects).not.toContain(LOGIN);
      expect(subjects).not.toContain(FEATURE);
    },
  );

  it(
    "subject 部分一致は語の途中でもヒットする(前後方一致でなく substring)",
    {
      annotation: {
        type: "description",
        description:
          "q='dark'(subject 途中の語)で search すると Feature request: dark mode がヒットすることを検証(部分一致が substring であり前方一致に退化していない)",
      },
    },
    async () => {
      const subjects = await subjectsOf({ q: "dark" });
      expect(subjects).toContain(FEATURE);
      expect(subjects).not.toContain(LOGIN);
      expect(subjects).not.toContain(BILLING);
    },
  );

  it(
    "SUP-12 形式は number 完全一致で検索する(SUP- プレフィクスを剥がす)",
    {
      annotation: {
        type: "description",
        description:
          "SUP-{n} 形式のチケットを1件作り、q='SUP-{n}' で search するとその number のチケットだけが完全一致で返り、部分一致に退化しない(近い番号を持つ別チケットが混入しない)ことを検証",
      },
    },
    async () => {
      // 決定論のため専用の subject を持つ2件を作り、片方の number を SUP-形式で引く。
      // seed の number(1..3)には依存しない — number は DB 採番のため作成結果から取る。
      const target = await store.create({
        subject: "Palette number-exact target",
        priority: "low",
        requesterEmail: CUSTOMER_EMAIL,
      });
      const near = await store.create({
        subject: "Palette number-exact neighbour",
        priority: "low",
        requesterEmail: CUSTOMER_EMAIL,
      });
      const num = (target as { number: number }).number;
      const rows = (await store.search({ q: `SUP-${num}` })) as Array<{
        number: number;
        subject: string;
      }>;
      expect(rows.map((r) => r.number)).toContain(num);
      // 完全一致なので neighbour(別 number)は返らない。これが無いと
      // 「SUP- を剥がして subject 部分一致」でも通ってしまう。
      expect(rows.map((r) => r.number)).not.toContain((near as { number: number }).number);
      expect(rows.every((r) => r.number === num)).toBe(true);

      // 敵対的レビューの指摘の固定: 「完全一致 → 数字の部分一致」への改竄は、
      // num を部分文字列に含む superstring 番号(例: 4 に対する 14)が無いと
      // 生き残る。superstring が採番されるまで作成し、混入しないことを見る。
      const created: number[] = [];
      for (let i = 0; created.length < 12 && i < 12; i++) {
        const t = await store.create({
          subject: `Palette superstring filler ${i}`,
          priority: "low",
          requesterEmail: CUSTOMER_EMAIL,
        });
        created.push((t as { number: number }).number);
      }
      const superstring = created.find((n) => n !== num && String(n).includes(String(num)));
      expect(superstring).toBeDefined();
      const exact = (await store.search({ q: String(num) })) as Array<{ number: number }>;
      expect(exact.map((r) => r.number)).toEqual([num]);
    },
  );

  it(
    "裸の数字(12)も number 完全一致で SUP-12 と同じ結果を返す",
    {
      annotation: {
        type: "description",
        description:
          "同一チケットを q='SUP-{n}' と q='{n}'(裸の数字)の両方で search したとき、返る number 集合が一致することを検証(SUP-n と n はどちらも number=n の完全一致)",
      },
    },
    async () => {
      const target = await store.create({
        subject: "Palette bare-number check",
        priority: "low",
        requesterEmail: CUSTOMER_EMAIL,
      });
      const num = (target as { number: number }).number;
      const withPrefix = (await store.search({ q: `SUP-${num}` })) as Array<{ number: number }>;
      const bareNumber = (await store.search({ q: `${num}` })) as Array<{ number: number }>;
      const byNumber = (a: number, b: number) => a - b;
      expect(bareNumber.map((r) => r.number).sort(byNumber)).toEqual(
        withPrefix.map((r) => r.number).sort(byNumber),
      );
      expect(bareNumber.map((r) => r.number)).toContain(num);
    },
  );

  it(
    "一致なしは空配列を返す(throw しない)",
    {
      annotation: {
        type: "description",
        description:
          "どのシード subject にも含まれない語(zzz-no-match-zzz)で search すると throw せず空配列を返すことを検証(該当なしはエラーにしない)",
      },
    },
    async () => {
      const rows = await store.search({ q: "zzz-no-match-zzz" });
      expect(rows).toEqual([]);
    },
  );

  it(
    "ILIKE のメタ文字 % はリテラル扱いされる(全件マッチにならない)",
    {
      annotation: {
        type: "description",
        description:
          "subject に '%' を含むチケットを1件作り、q='%' で search すると '%' をリテラルに含む行だけが返り、'%' が ILIKE のワイルドカードとして全件にマッチしないことを検証(メタ文字のエスケープ)",
      },
    },
    async () => {
      const literal = await store.create({
        subject: "Discount 50% coupon",
        priority: "low",
        requesterEmail: CUSTOMER_EMAIL,
      });
      const rows = (await store.search({ q: "%" })) as Array<{ id: string; subject: string }>;
      // '%' がワイルドカードなら全件(seed 3 + この1件)が返る。リテラルなら
      // '%' を含む1件のみ。ここでシードが漏れていないことがエスケープの証拠。
      expect(rows.map((r) => r.subject)).toContain((literal as { subject: string }).subject);
      expect(rows.map((r) => r.subject)).not.toContain(LOGIN);
      expect(rows.map((r) => r.subject)).not.toContain(BILLING);
      expect(rows.map((r) => r.subject)).not.toContain(FEATURE);
    },
  );

  it(
    "ILIKE のメタ文字 _ はリテラル扱いされる(任意1文字にならない)",
    {
      annotation: {
        type: "description",
        description:
          "subject に '_' を含むチケットを1件作り、q='cannot_login'(実データは空白区切り)で search してもヒットせず、'_' が ILIKE の任意1文字ワイルドカードとして扱われないことを検証(メタ文字のエスケープ)",
      },
    },
    async () => {
      const underscore = await store.create({
        subject: "snake_case_field bug",
        priority: "low",
        requesterEmail: CUSTOMER_EMAIL,
      });
      // '_' がワイルドカードなら 'cannot_login' はシードの 'Cannot login'(空白)に
      // マッチしてしまう。リテラルならマッチしない。
      const wildcardProbe = await subjectsOf({ q: "cannot_login" });
      expect(wildcardProbe).not.toContain(LOGIN);
      // 逆に '_' をリテラルに含む語ではヒットする(エスケープが検索を殺していない)。
      const literalHit = (await store.search({ q: "snake_case" })) as Array<{ subject: string }>;
      expect(literalHit.map((r) => r.subject)).toContain(
        (underscore as { subject: string }).subject,
      );
    },
  );

  it(
    "requesterEmail スコープ: 他人所有はヒットしない(自分所有のみ)",
    {
      annotation: {
        type: "description",
        description:
          "agent 所有のチケットを作り、同じ subject 語を requesterEmail=customer のスコープで search すると agent 所有行はヒットせず、customer 所有の同語シードはヒットすることを検証(ロールスコープは list と同一)",
      },
    },
    async () => {
      const agentOwned = "Billing escalation (agent-owned scope check)";
      await store.create({
        subject: agentOwned,
        priority: "low",
        requesterEmail: AGENT_EMAIL,
      });
      const subjects = await subjectsOf({ q: "billing", requesterEmail: CUSTOMER_EMAIL });
      // 自分所有(customer)の billing シードは出る。
      expect(subjects).toContain(BILLING);
      // agent 所有は scope で除外される。これが無いとスコープ未実装でも通る。
      expect(subjects).not.toContain(agentOwned);
    },
  );

  it(
    "最大 20 件に制限する(21件マッチでも 20 件まで)",
    {
      annotation: {
        type: "description",
        description:
          "同一の一意な語を subject に含むチケットを 21 件作り、その語で search すると返り件数が 20 件に制限されることを検証(limit 20)",
      },
    },
    async () => {
      const marker = "ZWENTYONEMARKER";
      for (let i = 0; i < 21; i++) {
        await store.create({
          subject: `Bulk ${marker} row ${i}`,
          priority: "low",
          requesterEmail: CUSTOMER_EMAIL,
        });
      }
      const rows = await store.search({ q: marker });
      expect(rows).toHaveLength(20);
    },
  );

  it(
    "並びは created_at DESC(新しいものが先頭)",
    {
      annotation: {
        type: "description",
        description:
          "同一の一意な語を含むチケットを時間差で複数作り、その語で search した結果が created_at 降順に並ぶ(最後に作った行が先頭)ことを検証(並び created_at DESC, id DESC)",
      },
    },
    async () => {
      const marker = "ORDERINGMARKER";
      const created: Array<{ id: string; createdAt: string }> = [];
      for (let i = 0; i < 3; i++) {
        const t = (await store.create({
          subject: `Order ${marker} ${i}`,
          priority: "low",
          requesterEmail: CUSTOMER_EMAIL,
        })) as { id: string; createdAt: string };
        created.push(t);
      }
      const rows = (await store.search({ q: marker })) as Array<{
        id: string;
        createdAt: string;
      }>;
      // 隣接ペアで created_at 単調非増加(DESC)。
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].createdAt >= rows[i].createdAt).toBe(true);
      }
      // 最後に作った行が先頭にいる(順序が実際に効いている証拠)。
      expect(rows[0].id).toBe(created[created.length - 1].id);
    },
  );
});
