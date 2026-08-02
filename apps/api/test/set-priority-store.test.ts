import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// set-priority extends the ticket store with a setPriority mutator (spec:
// specs/set-priority.md unit観点). setPriority(id, priority, actorEmail?) mirrors
// setStatus: it records a priority_changed event, bumps updated_at, and skips a
// same-value write. The method does not exist yet in this branch (RED). db.ts
// holds the connection helper, store.ts exposes createTicketStore(pool) + a named
// NotFoundError.
import { createPool, type Pool } from "../src/db.js";
import { createTicketStore, NotFoundError } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed seeds
// — the idempotent reset the store lane leans on for per-test isolation.
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

// Fixed seed ids (apps/api/db/seed.sql + specs/ticket-model.md シード). Seed
// priority は medium(specs/set-priority.md「New ticket で medium で作られる」の
// 前提と揃う。具体シード値には依存せず、変更前値を get() で読んで from に使う)。
const TICKET_1 = "00000000-0000-7000-8000-000000000001"; // "Cannot login" → auth, 未割り当て
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

describe("set-priority store: setPriority @feature-set-priority", () => {
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

  // 変更先は「現在値と必ず異なる」値を選ぶ(シードの具体値に依存しない)。
  function otherPriority(current: "low" | "medium" | "high"): "low" | "medium" | "high" {
    return current === "high" ? "low" : "high";
  }

  it(
    "setPriority は優先度を変更し priority_changed イベント(from/to)を記録する",
    {
      annotation: {
        type: "description",
        description:
          "現在値と異なる優先度に setPriority すると ticket.priority が更新され、priority_changed イベント(payload from=変更前 → to=変更後、actorEmail 付き)が1件記録されることを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      const from = before.ticket.priority;
      const to = otherPriority(from);

      const updated = await store.setPriority(TICKET_1, to);
      expect(updated.priority).toBe(to);

      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("priority_changed");
      expect(events[0].actorEmail).toBeTruthy();
      expect(events[0].payload).toEqual({ from, to });
    },
  );

  it(
    "setPriority は updated_at を単調増加させる",
    {
      annotation: {
        type: "description",
        description:
          "優先度変更に成功した際、チケットの updatedAt が変更前より後(単調増加)になることを検証(値そのものではなく増加をアンカー)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      const to = otherPriority(before.ticket.priority);
      await store.setPriority(TICKET_1, to);
      const after = await store.get(TICKET_1);
      expect(after.ticket.updatedAt >= before.ticket.updatedAt).toBe(true);
      expect(after.ticket.updatedAt).not.toBe(before.ticket.updatedAt);
    },
  );

  it(
    "setPriority は同値変更をスキップする(イベント・updated_at 不変)",
    {
      annotation: {
        type: "description",
        description:
          "現在値と同じ優先度を setPriority しても、イベントを追加せず updated_at も変えずに成功することを検証(setStatus と同じ同値スキップ)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      const same = before.ticket.priority;
      const updated = await store.setPriority(TICKET_1, same);
      expect(updated.priority).toBe(same);
      const after = await store.get(TICKET_1);
      expect(after.events).toHaveLength(0);
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
    },
  );

  it(
    "setPriority は actorEmail 省略時に 'system' を actor として記録する",
    {
      annotation: {
        type: "description",
        description:
          "actorEmail を省略して setPriority すると priority_changed イベントの actorEmail が 'system' で記録されることを検証(setStatus と同じシグネチャ規約)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await store.setPriority(TICKET_1, otherPriority(before.ticket.priority));
      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].actorEmail).toBe("system");
    },
  );

  it(
    "setPriority は渡した actorEmail を actor として記録する",
    {
      annotation: {
        type: "description",
        description:
          "actorEmail を明示して setPriority すると priority_changed イベントの actorEmail がその値で記録されることを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await store.setPriority(TICKET_1, otherPriority(before.ticket.priority), "agent@example.com");
      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].actorEmail).toBe("agent@example.com");
    },
  );

  it(
    "setPriority は未知の ticket id に NotFoundError を throw する",
    {
      annotation: {
        type: "description",
        description:
          "存在しない ticket id への setPriority が NotFoundError を throw することを検証",
      },
    },
    async () => {
      await expect(store.setPriority(MISSING_TICKET, "high")).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});

// pool.connect() が返す client の query を包み、ticket_events への INSERT だけを
// 失敗させる。他のクエリ(BEGIN/UPDATE/ROLLBACK 等)は素通し。ticket-model-
// atomicity.test.ts と同じ poisoned-pool イディオム。autocommit 化するミューテー
// ションが生き残らないよう、途中失敗が本体 UPDATE ごと巻き戻ることを固定する。
function poisonEventInsert(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(t, p) {
              if (p === "query") {
                return (...args: unknown[]) => {
                  const sql = args[0];
                  if (typeof sql === "string" && sql.includes("INSERT INTO ticket_events")) {
                    return Promise.reject(new Error("boom: event insert failed"));
                  }
                  return (t.query as (...a: unknown[]) => Promise<unknown>)(...args);
                };
              }
              const value = Reflect.get(t, p);
              return typeof value === "function" ? value.bind(t) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("set-priority store: イベントと本体の原子性 @feature-set-priority", () => {
  const pool = createPool(databaseUrl());
  const store = createTicketStore(pool);
  const poisoned = createTicketStore(poisonEventInsert(pool));

  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });
  afterAll(async () => {
    await pool.end();
  });

  it(
    "setPriority はイベント INSERT が失敗すると優先度更新ごと巻き戻る",
    {
      annotation: {
        type: "description",
        description:
          "priority_changed の INSERT だけを失敗させた setPriority が throw し、本体の priority・updated_at 更新もイベントも一切残らないことを検証(autocommit 化すると UPDATE が残って落ちる=同一トランザクション)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      const to = before.ticket.priority === "high" ? "low" : "high";
      await expect(poisoned.setPriority(TICKET_1, to)).rejects.toThrow(/boom/);
      const after = await store.get(TICKET_1);
      expect(after.ticket.priority).toBe(before.ticket.priority);
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
      expect(after.events).toHaveLength(0);
    },
  );
});
