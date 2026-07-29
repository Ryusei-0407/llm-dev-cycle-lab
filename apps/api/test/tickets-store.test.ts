import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// The store is being migrated to an async, pg-backed implementation (spec:
// specs/database.md). These are the public shapes the spec fixes; the modules
// do not exist yet in this branch (RED). db.ts holds the connection helper,
// store.ts exposes createTicketStore(pool) + a named NotFoundError.
import { createPool } from "../src/db.js";
import { createTicketStore, NotFoundError } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the 3 fixed
// seeds — the idempotent reset the store lane leans on for per-test isolation.
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// Connection comes from the vitest globalSetup (apps/api/test/global-setup.ts),
// which provisions/resets a temp DB and exports DATABASE_URL. Never hardcode a
// connection string here — POLICY.md §共通規約: 接続情報をテストコードに書かない.
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

// The deterministic seed, newest-first (created_at DESC). Matches the seed
// values in specs/tickets.md; timestamps are authored ascending by seed index
// so "Feature request" (the last seed) sorts to the head.
const SEED_SUBJECTS_DESC = [
  "Feature request: dark mode",
  "Billing question",
  "Cannot login to dashboard",
];

// UUID v7: the 13th hex digit (version nibble) is '7', the 17th (variant) is
// 8/9/a/b. Created ids come from the DB's uuidv7() default (spec: database.md),
// so the app never generates them — the DB stamping is what this asserts.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ticket store (postgres) @feature-tickets", () => {
  let pool: Pool;
  let store: ReturnType<typeof createTicketStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createTicketStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Per-test isolation: reset schema + seed before every case so a mutation in
  // one test cannot leak into the next (M1 の共有ストア汚染の教訓).
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "list はシード3件を created_at 降順で決定的に返す",
    {
      annotation: {
        type: "description",
        description: "list がシード3件を created_at 降順の決定的順序で返すことを検証",
      },
    },
    async () => {
      const list = await store.list();
      expect(list).toHaveLength(3);
      expect(list.map((t) => t.subject)).toEqual(SEED_SUBJECTS_DESC);
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].createdAt >= list[i].createdAt).toBe(true);
      }
    },
  );

  it(
    "list は各シードの status/priority/requester を仕様どおり返す",
    {
      annotation: {
        type: "description",
        description:
          "各シードチケットの status/priority/requesterEmail が仕様値と一致することを検証",
      },
    },
    async () => {
      const bySubject = new Map((await store.list()).map((t) => [t.subject, t]));
      expect(bySubject.get("Cannot login to dashboard")).toMatchObject({
        status: "open",
        priority: "high",
        requesterEmail: "customer@example.com",
      });
      expect(bySubject.get("Billing question")).toMatchObject({
        status: "in_progress",
        priority: "medium",
        requesterEmail: "customer@example.com",
      });
      expect(bySubject.get("Feature request: dark mode")).toMatchObject({
        status: "resolved",
        priority: "low",
        requesterEmail: "customer@example.com",
      });
    },
  );

  it(
    "create は新規チケットを永続化し一覧先頭に open で現れる",
    {
      annotation: {
        type: "description",
        description:
          "create したチケットが fresh id/open で永続化され、再取得した一覧の先頭に現れることを検証",
      },
    },
    async () => {
      const created = await store.create({
        subject: "New printer jam",
        priority: "medium",
        requesterEmail: "ops@example.com",
      });
      expect(created.id).toMatch(UUID_V7);
      expect(created.status).toBe("open");
      expect(created.priority).toBe("medium");
      expect(created.subject).toBe("New printer jam");
      expect(created.requesterEmail).toBe("ops@example.com");
      expect(typeof created.createdAt).toBe("string");

      // Re-fetch through the store: proves it went to the DB, not just memory.
      const list = await store.list();
      expect(list).toHaveLength(4);
      expect(list[0].id).toBe(created.id);
      expect(list[0].subject).toBe("New printer jam");
    },
  );

  it(
    "create は毎回異なる id を割り当てる",
    {
      annotation: {
        type: "description",
        description: "連続 create が互いに異なる id を割り当てることを検証",
      },
    },
    async () => {
      const a = await store.create({
        subject: "First",
        priority: "low",
        requesterEmail: "a@example.com",
      });
      const b = await store.create({
        subject: "Second",
        priority: "low",
        requesterEmail: "b@example.com",
      });
      expect(a.id).not.toBe(b.id);
    },
  );

  it(
    "create の id は UUID v7(version ニブルが 7)である",
    {
      annotation: {
        type: "description",
        description:
          "create したチケットの id が DB の uuidv7() 由来で version ニブルが '7' の UUID v7 であることを検証",
      },
    },
    async () => {
      const created = await store.create({
        subject: "v7 check",
        priority: "low",
        requesterEmail: "a@example.com",
      });
      expect(created.id).toMatch(UUID_V7);
      // 13th hex digit (index 14, after two hyphens) is the version nibble.
      expect(created.id[14]).toBe("7");
    },
  );

  it(
    "create は空 subject を拒否し件数を増やさない",
    {
      annotation: {
        type: "description",
        description:
          "空 subject の create が reject され、永続化件数がシード3件のままであることを検証",
      },
    },
    async () => {
      await expect(
        store.create({ subject: "", priority: "low", requesterEmail: "a@example.com" }),
      ).rejects.toThrow();
      expect(await store.list()).toHaveLength(3);
    },
  );

  it(
    "create は200文字超の subject を拒否し件数を増やさない",
    {
      annotation: {
        type: "description",
        description:
          "201文字 subject の create が reject され、永続化件数がシード3件のままであることを検証",
      },
    },
    async () => {
      await expect(
        store.create({
          subject: "x".repeat(201),
          priority: "low",
          requesterEmail: "a@example.com",
        }),
      ).rejects.toThrow();
      expect(await store.list()).toHaveLength(3);
    },
  );

  it(
    "create は境界の200文字 subject を受理する",
    {
      annotation: {
        type: "description",
        description: "ちょうど200文字の subject を create が受理し永続化することを検証",
      },
    },
    async () => {
      const created = await store.create({
        subject: "x".repeat(200),
        priority: "high",
        requesterEmail: "a@example.com",
      });
      expect(created.subject).toHaveLength(200);
    },
  );

  it(
    "setStatus は既存チケットの status を更新して永続化する",
    {
      annotation: {
        type: "description",
        description: "setStatus が既存チケットの status を更新し、再取得後もその値が残ることを検証",
      },
    },
    async () => {
      const target = (await store.list())[0];
      const updated = await store.setStatus(target.id, "resolved");
      expect(updated.id).toBe(target.id);
      expect(updated.status).toBe("resolved");
      const reloaded = (await store.list()).find((t) => t.id === target.id);
      expect(reloaded?.status).toBe("resolved");
    },
  );

  it(
    "setStatus は未知の id に NotFoundError を throw する",
    {
      annotation: {
        type: "description",
        description: "存在しない id への setStatus が NotFoundError を throw することを検証",
      },
    },
    async () => {
      await expect(
        store.setStatus("00000000-0000-7000-8000-0000000000ff", "open"),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  // Isolation guard: deliberately pollute (create + mutate), then rely on
  // beforeEach's reset in the *next* test to prove state does not leak. This
  // pair is the regression fixture for the M1 shared-store contamination.
  it(
    "汚染テスト: create/setStatus で状態を意図的に汚す",
    {
      annotation: {
        type: "description",
        description:
          "後続テストの分離を検証するため、create と setStatus でストア状態を意図的に汚染する",
      },
    },
    async () => {
      await store.create({
        subject: "Pollution",
        priority: "high",
        requesterEmail: "x@example.com",
      });
      const first = (await store.list())[0];
      await store.setStatus(first.id, "resolved");
      expect(await store.list()).toHaveLength(4);
    },
  );

  it(
    "分離確認: 直前の汚染が beforeEach でリセットされ初期3件に戻る",
    {
      annotation: {
        type: "description",
        description:
          "直前テストの汚染が beforeEach の seed リセットで消え、件数と順序が初期シード3件に戻ることを検証",
      },
    },
    async () => {
      const list = await store.list();
      expect(list).toHaveLength(3);
      expect(list.map((t) => t.subject)).toEqual(SEED_SUBJECTS_DESC);
    },
  );
});

describe("applySchemaAndSeed 冪等性 @feature-tickets", () => {
  it(
    "2回適用してもエラーなくシード3件になる",
    {
      annotation: {
        type: "description",
        description:
          "applySchemaAndSeed を同一DBに2回適用してもエラーにならず、シードが重複せず3件のままであることを検証",
      },
    },
    async () => {
      const url = databaseUrl();
      await applySchemaAndSeed(url);
      await applySchemaAndSeed(url);

      const pool = new Pool({ connectionString: url });
      try {
        const { rows } = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM tickets",
        );
        expect(rows[0].count).toBe("3");
      } finally {
        await pool.end();
      }
    },
  );
});

describe("db guards @feature-tickets", () => {
  it(
    "rejects trpc access with 500 db_misconfigured when DATABASE_URL is unset",
    {
      annotation: {
        type: "description",
        description:
          "DATABASE_URL 未設定で tickets API にアクセスした際に 500 db_misconfigured を返すガードを検証",
      },
    },
    async () => {
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const { createApp } = await import("../src/app.js");
        const res = await createApp().request("/api/rpc/tickets/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "db_misconfigured" });
      } finally {
        process.env.DATABASE_URL = saved;
      }
    },
  );

  it(
    "enforces schema CHECK constraints as the last line of defence",
    {
      annotation: {
        type: "description",
        description:
          "zod を迂回した直接 INSERT でも schema の CHECK 制約(subject長・status・priority)が拒否することを検証",
      },
    },
    async () => {
      const pool = createPool(databaseUrl());
      await applySchemaAndSeed(databaseUrl());
      await expect(
        pool.query(
          "INSERT INTO tickets (subject, status, priority, requester_email) VALUES ('', 'open', 'low', 'x@example.com')",
        ),
      ).rejects.toThrow(/check constraint/i);
      await expect(
        pool.query(
          "INSERT INTO tickets (subject, status, priority, requester_email) VALUES ('ok', 'bogus', 'low', 'x@example.com')",
        ),
      ).rejects.toThrow(/check constraint/i);
      await expect(
        pool.query(
          "INSERT INTO tickets (subject, status, priority, requester_email) VALUES ('ok', 'open', 'urgent', 'x@example.com')",
        ),
      ).rejects.toThrow(/check constraint/i);
      await pool.end();
    },
  );
});
