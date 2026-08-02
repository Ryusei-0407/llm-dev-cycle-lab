import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// insights (spec: specs/insights.md) adds a single aggregation method the oRPC
// procedure reads as its only ground truth: store.insights(now?) → Insights.
// The method does not exist yet on this branch (RED). db.ts holds the connection
// helper, store.ts exposes createTicketStore(pool) — same import surface as the
// existing store tests (tickets-store / copilot-snapshot).
import { createPool } from "../src/db.js";
import { createTicketStore } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed seeds,
// the idempotent reset the store lane leans on for per-test isolation.
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

// Fixed seed state (apps/api/db/seed.sql)。tickets は number 1..3(SUP-1..3):
//   1 "Cannot login to dashboard"   open        high   unassigned  label=auth
//   2 "Billing question"            in_progress medium assignee=agent  label=billing
//   3 "Feature request: dark mode"  resolved    low    unassigned  label=request
// labels カタログは固定5件: auth/billing/api/email/request(api・email は 0 件)。
const TICKET_IDS = {
  login: "00000000-0000-7000-8000-000000000001",
  billing: "00000000-0000-7000-8000-000000000002",
  feature: "00000000-0000-7000-8000-000000000003",
} as const;

// Seed label colours (seed.sql)。byLabel の color を検証するのに使う。
const LABEL_COLORS = {
  api: "#6a8dff",
  auth: "#e2626b",
  billing: "#f2c94c",
  email: "#27a644",
  request: "#9a6ae2",
} as const;

// Anchor "now" for the 14-day window assertions. Everything is expressed
// relative to this instant so the tests never read wall-clock time. Chosen mid
// month so ±14 days never crosses a year boundary.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 24 * 3600_000;

// UTC "YYYY-MM-DD" for now + offset days. resolvedByDay keys are UTC dates.
function utcDate(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * DAY).toISOString().slice(0, 10);
}

describe("store.insights @feature-insights", () => {
  let pool: Pool;
  let store: ReturnType<typeof createTicketStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createTicketStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Per-test isolation: reset schema + seed before every case (共有ストア汚染の教訓)。
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  // Insert a status_changed event directly with an explicit created_at, the seam
  // resolvedByDay aggregates over (spec 備考: ticket_events, payload->>'to').
  // Direct INSERT (not a store mutation) keeps created_at deterministic and
  // independent of wall-clock now() — the same "direct pool.query" seam the
  // store tests use for time-window inputs.
  async function insertResolvedEvent(ticketId: string, createdAtIso: string): Promise<void> {
    await pool.query(
      `INSERT INTO ticket_events (ticket_id, actor_email, type, payload, created_at)
       VALUES ($1, 'agent@example.com', 'status_changed', $2::jsonb, $3)`,
      [ticketId, JSON.stringify({ from: "in_progress", to: "resolved" }), createdAtIso],
    );
  }

  it(
    "byStatus / byPriority はシードの分布(各1件)を返す",
    {
      annotation: {
        type: "description",
        description:
          "store.insights が byStatus を {open:1,in_progress:1,resolved:1}、byPriority を {low:1,medium:1,high:1} とシードの分布どおり集計して返すことを検証(SQL 集計が根拠)",
      },
    },
    async () => {
      const insights = await store.insights(NOW);
      expect(insights.byStatus).toEqual({ open: 1, in_progress: 1, resolved: 1 });
      expect(insights.byPriority).toEqual({ low: 1, medium: 1, high: 1 });
    },
  );

  it(
    "unassigned は assignee NULL かつ未解決のみを数える(resolved の未割当は除外)",
    {
      annotation: {
        type: "description",
        description:
          "store.insights.unassigned が『assignee IS NULL かつ status<>resolved』を満たす SUP-1 のみを 1 と数え、割当済みの SUP-2 と未割当だが resolved の SUP-3 を除外することを検証",
      },
    },
    async () => {
      // Seed: SUP-1 open/unassigned → 数える。SUP-2 assigned → 除外。
      // SUP-3 resolved/unassigned → status 条件で除外。
      const insights = await store.insights(NOW);
      expect(insights.unassigned).toBe(1);
    },
  );

  it(
    "byLabel は name 昇順で 0 件ラベルも含み、各ラベルの color と count を返す",
    {
      annotation: {
        type: "description",
        description:
          "store.insights.byLabel が固定カタログ5件を name 昇順(api,auth,billing,email,request)で返し、シードで付与済みの auth/billing/request を count 1、未使用の api/email を count 0 として 0 件ラベルも欠落させず、各要素に seed の color を伴うことを検証",
      },
    },
    async () => {
      const insights = await store.insights(NOW);
      expect(insights.byLabel).toEqual([
        { name: "api", color: LABEL_COLORS.api, count: 0 },
        { name: "auth", color: LABEL_COLORS.auth, count: 1 },
        { name: "billing", color: LABEL_COLORS.billing, count: 1 },
        { name: "email", color: LABEL_COLORS.email, count: 0 },
        { name: "request", color: LABEL_COLORS.request, count: 1 },
      ]);
    },
  );

  it(
    "resolvedByDay は今日を含む直近14日を UTC 日付昇順で返し、該当なしの日は 0 で埋める",
    {
      annotation: {
        type: "description",
        description:
          "store.insights.resolvedByDay が今日(now の UTC 日)を末尾に含む昇順14要素を返し、date が UTC 'YYYY-MM-DD' で連続し、resolved イベントの無い日はすべて count 0 で埋まることを、now 注入で検証",
      },
    },
    async () => {
      const insights = await store.insights(NOW);
      expect(insights.resolvedByDay).toHaveLength(14);
      // 先頭は now-13日、末尾は now(今日)。UTC 連続日付。
      const dates = insights.resolvedByDay.map((d) => d.date);
      const expectedDates = Array.from({ length: 14 }, (_, i) => utcDate(NOW, i - 13));
      expect(dates).toEqual(expectedDates);
      // イベントを入れていないので全日 0。
      for (const day of insights.resolvedByDay) {
        expect(day.count).toBe(0);
      }
    },
  );

  it(
    "resolvedByDay は status_changed(to='resolved')イベントを発生日(UTC)ごとに数える",
    {
      annotation: {
        type: "description",
        description:
          "ticket_events に payload.to='resolved' の status_changed を『今日』と『now-3日』に直接 INSERT すると、resolvedByDay の該当2日の count が 1 になり、他の日は 0 のままであることを、now 注入で検証(集計対象は ticket_events の created_at の UTC 日)",
      },
    },
    async () => {
      await insertResolvedEvent(TICKET_IDS.login, new Date(NOW.getTime()).toISOString());
      await insertResolvedEvent(
        TICKET_IDS.billing,
        new Date(NOW.getTime() - 3 * DAY).toISOString(),
      );

      const insights = await store.insights(NOW);
      const byDate = new Map(insights.resolvedByDay.map((d) => [d.date, d.count]));
      expect(byDate.get(utcDate(NOW, 0))).toBe(1);
      expect(byDate.get(utcDate(NOW, -3))).toBe(1);
      // それ以外の日は 0。
      const total = insights.resolvedByDay.reduce((sum, d) => sum + d.count, 0);
      expect(total).toBe(2);
    },
  );

  it(
    "resolvedByDay は同一チケットが同日に複数回 resolved になっても 1 と数える(重複排除)",
    {
      annotation: {
        type: "description",
        description:
          "同じチケットに対する payload.to='resolved' の status_changed イベントを同じ UTC 日に2回 INSERT しても、その日の resolvedByDay.count が(2 ではなく)1 に重複排除されることを検証(count は『その日 resolved へ変化したチケット数』)",
      },
    },
    async () => {
      // 同一チケット・同一 UTC 日に 2 回 resolved 化(再オープン→再解決を模す)。
      await insertResolvedEvent(TICKET_IDS.login, new Date(NOW.getTime()).toISOString());
      await insertResolvedEvent(
        TICKET_IDS.login,
        new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
      );

      const insights = await store.insights(NOW);
      const byDate = new Map(insights.resolvedByDay.map((d) => [d.date, d.count]));
      // 2 イベントだが同一チケット・同日なので 1。
      expect(byDate.get(utcDate(NOW, 0))).toBe(1);
      const total = insights.resolvedByDay.reduce((sum, d) => sum + d.count, 0);
      expect(total).toBe(1);
    },
  );

  it(
    "resolvedByDay は14日窓より古い resolved イベントを含めない(境界の外側)",
    {
      annotation: {
        type: "description",
        description:
          "payload.to='resolved' のイベントを『now-14日』(14要素窓の先頭 now-13日より 1 日古い)に INSERT すると resolvedByDay のどの日にも数えられず、全日 count 0 のままであることを検証(直近14日の下限境界)",
      },
    },
    async () => {
      // 窓は now-13..now(14日)。now-14日はその外側。
      await insertResolvedEvent(TICKET_IDS.login, new Date(NOW.getTime() - 14 * DAY).toISOString());
      const insights = await store.insights(NOW);
      const total = insights.resolvedByDay.reduce((sum, d) => sum + d.count, 0);
      expect(total).toBe(0);
      // 念のため窓の下限日(now-13)も 0。
      const byDate = new Map(insights.resolvedByDay.map((d) => [d.date, d.count]));
      expect(byDate.get(utcDate(NOW, -13))).toBe(0);
    },
  );

  it(
    "now 未指定でも現在時刻を既定に集計を返す(注入は任意)",
    {
      annotation: {
        type: "description",
        description:
          "store.insights を引数なしで呼んでも既定 new Date() で集計され、byStatus 合計がシード総数 3・resolvedByDay が14要素であること(now は任意注入)を検証",
      },
    },
    async () => {
      const insights = await store.insights();
      const total =
        insights.byStatus.open + insights.byStatus.in_progress + insights.byStatus.resolved;
      expect(total).toBe(3);
      expect(insights.resolvedByDay).toHaveLength(14);
    },
  );
});
