import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db.js";
import { createTicketStore } from "../src/tickets/store.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// spec: specs/ticket-model.md 整合性 —「イベント記録と本体 UPDATE は同一
// トランザクション(片方だけ残らない)」。敵対的レビューの指摘の固定:
// 既存の原子性テストはトランザクション突入前の検証失敗しか突いておらず、
// withTransaction を autocommit 化するミューテーションが生き残っていた。
// ここでは ticket_events への INSERT だけを人工的に失敗させ、途中失敗が
// 本体 UPDATE ごと巻き戻ることを検証する(autocommit 化すると UPDATE が
// 残ってこのテストが落ちる = ミューテーションを殺す)。

const TICKET_1 = "00000000-0000-7000-8000-000000000001"; // open / auth ラベル

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

// pool.connect() が返す client の query を包み、ticket_events への INSERT
// だけを失敗させる。他のクエリ(BEGIN/UPDATE/ROLLBACK 等)は素通し。
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

describe("ticket-model 原子性(途中失敗の巻き戻し) @feature-ticket-model", () => {
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
    "setStatus はイベント INSERT が失敗すると status 更新ごと巻き戻る",
    {
      annotation: {
        type: "description",
        description:
          "status_changed の INSERT だけを失敗させた setStatus が throw し、本体の status・updated_at 更新もイベントも一切残らないことを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await expect(poisoned.setStatus(TICKET_1, "resolved")).rejects.toThrow(/boom/);
      const after = await store.get(TICKET_1);
      expect(after.ticket.status).toBe("open");
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
      expect(after.events).toHaveLength(0);
    },
  );

  it(
    "setLabels はイベント INSERT が失敗するとラベル置換ごと巻き戻る",
    {
      annotation: {
        type: "description",
        description:
          "labels_changed の INSERT だけを失敗させた setLabels が throw し、DELETE/INSERT 済みだったラベル置換(auth→billing)が巻き戻って元の付与が残ることを検証",
      },
    },
    async () => {
      await expect(poisoned.setLabels(TICKET_1, ["billing"])).rejects.toThrow(/boom/);
      const { ticket, events } = await store.get(TICKET_1);
      expect(ticket.labels.map((l) => l.name)).toEqual(["auth"]);
      expect(events).toHaveLength(0);
    },
  );
});
