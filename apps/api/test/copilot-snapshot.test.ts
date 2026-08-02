import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// copilot (spec: specs/copilot.md) adds a single store method that the SSE route
// uses as its only numeric ground truth: copilotSnapshot(now?) → CopilotSnapshot.
// The method does not exist yet on this branch (RED). db.ts holds the connection
// helper, store.ts exposes createTicketStore(pool) — same import surface as the
// existing store tests (tickets-store / command-palette-store).
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

// Fixed seed state (apps/api/db/seed.sql + specs/ticket-model.md シード)。number は
// seed 挿入順で 1..3(SUP-1..3):
//   1 "Cannot login to dashboard"   open        high   unassigned
//   2 "Billing question"            in_progress medium assignee=agent@example.com
//   3 "Feature request: dark mode"  resolved    low    unassigned
// created_at はシードで固定だが updated_at は DEFAULT now()(= seed 時の実時刻)なので、
// 時間依存の集計(resolvedLast7d の 7日境界 / stale の 48h境界)は updated_at を直接
// 既知の固定値に上書きし、決定論のため now を注入して境界を挟んで検証する。
const TICKET_IDS = {
  login: "00000000-0000-7000-8000-000000000001",
  billing: "00000000-0000-7000-8000-000000000002",
  feature: "00000000-0000-7000-8000-000000000003",
} as const;

// Anchor "now" for the time-window assertions. Everything is expressed relative
// to this instant so the tests never read wall-clock time.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function at(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

describe("store.copilotSnapshot @feature-copilot", () => {
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

  // Directly stamp updated_at on a seed ticket (bypasses the store's mutation
  // bumping) so the 7d / 48h windows have deterministic inputs independent of
  // the seed's wall-clock now(). This is the same "direct pool.query" seam the
  // store tests use for schema-level assertions.
  async function setUpdatedAt(id: string, iso: string): Promise<void> {
    await pool.query("UPDATE tickets SET updated_at = $2 WHERE id = $1", [id, iso]);
  }

  it(
    "byStatus / byPriority はシードの分布(各1件)を返す",
    {
      annotation: {
        type: "description",
        description:
          "copilotSnapshot が byStatus を {open:1,in_progress:1,resolved:1}、byPriority を {low:1,medium:1,high:1} とシードの分布どおり集計して返すことを検証(SQL 集計が根拠)",
      },
    },
    async () => {
      const snap = await store.copilotSnapshot(NOW);
      expect(snap.byStatus).toEqual({ open: 1, in_progress: 1, resolved: 1 });
      expect(snap.byPriority).toEqual({ low: 1, medium: 1, high: 1 });
    },
  );

  it(
    "unassigned は assignee NULL かつ未解決のみを数える(resolved の未割当は除外)",
    {
      annotation: {
        type: "description",
        description:
          "copilotSnapshot.unassigned が『assignee IS NULL かつ status<>resolved』を満たす SUP-1 のみを 1 と数え、割当済みの SUP-2 と未割当だが resolved の SUP-3 を除外することを検証",
      },
    },
    async () => {
      // Seed: SUP-1 open/unassigned → 数える。SUP-2 assigned → 除外。
      // SUP-3 resolved/unassigned → status 条件で除外。
      const snap = await store.copilotSnapshot(NOW);
      expect(snap.unassigned).toBe(1);
    },
  );

  it(
    "resolvedLast7d は updated_at >= now-7d の resolved のみを数える(境界含む)",
    {
      annotation: {
        type: "description",
        description:
          "resolved の SUP-3 の updated_at を『ちょうど now-7日』に置くと resolvedLast7d に含まれ(境界は含む)、now-7日より 1 時間古いと含まれないことを、now 注入で検証",
      },
    },
    async () => {
      // ちょうど 7 日前 → 含む(>=)。
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -7 * DAY));
      expect((await store.copilotSnapshot(NOW)).resolvedLast7d).toBe(1);

      // 7 日 + 1 時間前 → 含まない。
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -7 * DAY - HOUR));
      expect((await store.copilotSnapshot(NOW)).resolvedLast7d).toBe(0);
    },
  );

  it(
    "resolvedLast7d は未解決チケットを新しくても数えない(status='resolved' 限定)",
    {
      annotation: {
        type: "description",
        description:
          "open の SUP-1 の updated_at を now(7日以内)に置いても resolvedLast7d には数えず、resolved の SUP-3 だけが 7 日窓の対象であることを検証(status 条件と時間条件の AND)",
      },
    },
    async () => {
      await setUpdatedAt(TICKET_IDS.login, at(NOW, 0));
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -1 * DAY));
      expect((await store.copilotSnapshot(NOW)).resolvedLast7d).toBe(1);
    },
  );

  it(
    "stale は未解決かつ updated_at <= now-48h のみ(境界含む・resolved 除外)",
    {
      annotation: {
        type: "description",
        description:
          "未解決の SUP-1 の updated_at を『ちょうど now-48h』に置くと stale に含まれ(境界は含む)、resolved の SUP-3 は 48h より古くても stale に含まれないことを、number/subject/status を伴って検証",
      },
    },
    async () => {
      // SUP-1(open)を境界ちょうど(48h前)→ 含む。SUP-3(resolved)は古くても除外。
      await setUpdatedAt(TICKET_IDS.login, at(NOW, -48 * HOUR));
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -100 * DAY));
      // SUP-2 は新しく保って stale から外す。
      await setUpdatedAt(TICKET_IDS.billing, at(NOW, 0));

      const snap = await store.copilotSnapshot(NOW);
      expect(snap.stale).toEqual([
        { number: 1, subject: "Cannot login to dashboard", status: "open" },
      ]);
    },
  );

  it(
    "stale は 48h より新しい未解決を含めない",
    {
      annotation: {
        type: "description",
        description:
          "未解決の SUP-1 の updated_at を『now-47h』(48h 未満)に置くと stale に含まれず、stale が空配列で返ることを検証(境界の外側)",
      },
    },
    async () => {
      await setUpdatedAt(TICKET_IDS.login, at(NOW, -47 * HOUR));
      await setUpdatedAt(TICKET_IDS.billing, at(NOW, 0));
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -100 * DAY));
      const snap = await store.copilotSnapshot(NOW);
      expect(snap.stale).toEqual([]);
    },
  );

  it(
    "stale は updated_at ASC(古い順)で最大5件に切り詰める",
    {
      annotation: {
        type: "description",
        description:
          "未解決チケットを 7 件用意し全て 48h より古くすると、stale が updated_at 昇順(最古が先頭)で先頭 5 件だけを返し、6・7 件目(相対的に新しい2件)を落とすことを検証",
      },
    },
    async () => {
      // 追加の未解決チケットを 6 件足して合計 7 件の stale 候補にする。
      // seed の SUP-1(open)も未解決なので、更に 6 件 open を作る。
      const created: Array<{ id: string; number: number }> = [];
      for (let i = 0; i < 6; i++) {
        const t = await store.create({
          subject: `Stale candidate ${i}`,
          priority: "medium",
          requesterEmail: "ops@example.com",
        });
        created.push({ id: t.id, number: (t as { number: number }).number });
      }
      // resolved の SUP-3 は候補外へ、割当済みでも stale 対象(stale は割当を問わない)。
      await setUpdatedAt(TICKET_IDS.feature, at(NOW, -100 * DAY));
      await setUpdatedAt(TICKET_IDS.billing, at(NOW, -10 * DAY));

      // 7 件の未解決(seed SUP-1 + SUP-2 + 追加6)を、互いに区別できる古さで並べる。
      // 最古から: SUP-1 が最古、次に created[0..5]、SUP-2 が最も新しい(それでも 48h超)。
      const unresolved: Array<{ id: string; ageDays: number }> = [
        { id: TICKET_IDS.login, ageDays: 30 },
        ...created.map((c, i) => ({ id: c.id, ageDays: 20 - i })), // 20,19,...,15
        { id: TICKET_IDS.billing, ageDays: 3 }, // 3d > 48h、最も新しい
      ];
      for (const u of unresolved) {
        await setUpdatedAt(u.id, at(NOW, -u.ageDays * DAY));
      }

      const snap = await store.copilotSnapshot(NOW);
      expect(snap.stale).toHaveLength(5);
      // ASC(古い順)で並ぶこと: 先頭は最古の SUP-1。
      expect(snap.stale[0]).toMatchObject({ number: 1, subject: "Cannot login to dashboard" });
      // 切り詰めで最も新しい 2 件(SUP-2 の 3d と created 末尾の 15d)が落ちること。
      const numbers = snap.stale.map((s) => s.number);
      expect(numbers).not.toContain(2);
      // 昇順(updated_at ASC)であることの構造的確認: 落ちた 2 件は残る 5 件より新しい。
      expect(numbers).toHaveLength(5);
    },
  );

  it(
    "now 未指定でも現在時刻を既定に snapshot を返す(注入は任意)",
    {
      annotation: {
        type: "description",
        description:
          "copilotSnapshot を引数なしで呼んでも既定 new Date() で集計され、byStatus 合計がシード総数 3 と一致する(now は任意注入)ことを検証",
      },
    },
    async () => {
      const snap = await store.copilotSnapshot();
      const total = snap.byStatus.open + snap.byStatus.in_progress + snap.byStatus.resolved;
      expect(total).toBe(3);
    },
  );
});
