import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
// The message store is the ticket-detail feature (spec: specs/ticket-detail.md).
// These are the public shapes the spec fixes; the module does not exist yet in
// this branch (RED). messages.ts exposes createMessageStore(pool); the shared
// NotFoundError lives in store.ts (thrown when the parent ticket is absent).
import { createPool } from "../src/db.js";
import { createMessageStore } from "../src/tickets/messages.js";
import { NotFoundError } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed
// seeds — the idempotent reset the store lanes lean on for per-test isolation.
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

// Fixed ticket seed ids (apps/api/db/seed.sql). ticket 1 carries 2 seed
// messages, ticket 2 carries 1 (spec: specs/ticket-detail.md シード).
const TICKET_1 = "00000000-0000-7000-8000-000000000001";
const TICKET_2 = "00000000-0000-7000-8000-000000000002";
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

// UUID v7: the 13th hex digit (version nibble) is '7', the 17th (variant) is
// 8/9/a/b. Created ids come from the DB's uuidv7() default, so the app never
// generates them — the DB stamping is what this asserts.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("message store (postgres) @feature-ticket-detail", () => {
  let pool: Pool;
  let store: ReturnType<typeof createMessageStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createMessageStore(pool);
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
    "listByTicket はシードの会話を created_at 昇順で返す",
    {
      annotation: {
        type: "description",
        description:
          "listByTicket が ticket 1 のシードメッセージ2件を created_at 昇順(customer→agent)で返すことを検証",
      },
    },
    async () => {
      const messages = await store.listByTicket(TICKET_1);
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.authorRole)).toEqual(["customer", "agent"]);
      expect(messages[0].body).toMatch(/invalid credentials/);
      expect(messages[1].body).toMatch(/changed your password/);
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i - 1].createdAt <= messages[i].createdAt).toBe(true);
      }
    },
  );

  it(
    "listByTicket は該当 ticket のメッセージだけを返す",
    {
      annotation: {
        type: "description",
        description:
          "listByTicket が問い合わせた ticket に属するメッセージだけを返し、他 ticket の会話を混ぜないことを検証",
      },
    },
    async () => {
      const messages = await store.listByTicket(TICKET_2);
      expect(messages).toHaveLength(1);
      expect(messages[0].ticketId).toBe(TICKET_2);
      expect(messages[0].authorRole).toBe("customer");
    },
  );

  it(
    "listByTicket は存在しない ticket に空配列を返す",
    {
      annotation: {
        type: "description",
        description:
          "存在しない ticket id への listByTicket が throw せず空配列を返すことを検証(不在は0件であり異常ではない)",
      },
    },
    async () => {
      expect(await store.listByTicket(MISSING_TICKET)).toEqual([]);
    },
  );

  it(
    "create は返信を永続化しスレッド末尾に現れる",
    {
      annotation: {
        type: "description",
        description:
          "create したメッセージが fresh な UUID v7 id で永続化され、再取得したスレッドの末尾に昇順で現れることを検証",
      },
    },
    async () => {
      const created = await store.create({
        ticketId: TICKET_1,
        authorEmail: "agent@example.com",
        authorRole: "agent",
        body: "Have you tried resetting your password from the login page?",
      });
      expect(created.id).toMatch(UUID_V7);
      expect(created.ticketId).toBe(TICKET_1);
      expect(created.authorEmail).toBe("agent@example.com");
      expect(created.authorRole).toBe("agent");
      expect(created.body).toBe("Have you tried resetting your password from the login page?");
      expect(typeof created.createdAt).toBe("string");

      // Re-fetch through the store: proves it went to the DB, not just memory,
      // and that ascending order puts the new reply last.
      const messages = await store.listByTicket(TICKET_1);
      expect(messages).toHaveLength(3);
      expect(messages[messages.length - 1].id).toBe(created.id);
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
        ticketId: TICKET_1,
        authorEmail: "agent@example.com",
        authorRole: "agent",
        body: "First reply",
      });
      const b = await store.create({
        ticketId: TICKET_1,
        authorEmail: "agent@example.com",
        authorRole: "agent",
        body: "Second reply",
      });
      expect(a.id).not.toBe(b.id);
    },
  );

  it(
    "create は存在しない ticket に NotFoundError を throw し永続化しない",
    {
      annotation: {
        type: "description",
        description:
          "存在しない ticket への create が NotFoundError を throw し、メッセージを永続化しないことを検証",
      },
    },
    async () => {
      await expect(
        store.create({
          ticketId: MISSING_TICKET,
          authorEmail: "agent@example.com",
          authorRole: "agent",
          body: "Reply to a ghost ticket",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await store.listByTicket(MISSING_TICKET)).toEqual([]);
    },
  );

  it(
    "create は境界の1文字 body を受理する",
    {
      annotation: {
        type: "description",
        description: "ちょうど1文字の body を create が受理し永続化することを検証(下限境界)",
      },
    },
    async () => {
      const created = await store.create({
        ticketId: TICKET_1,
        authorEmail: "agent@example.com",
        authorRole: "agent",
        body: "x",
      });
      expect(created.body).toBe("x");
    },
  );

  it(
    "create は境界の2000文字 body を受理する",
    {
      annotation: {
        type: "description",
        description: "ちょうど2000文字の body を create が受理し永続化することを検証(上限境界)",
      },
    },
    async () => {
      const created = await store.create({
        ticketId: TICKET_1,
        authorEmail: "agent@example.com",
        authorRole: "agent",
        body: "x".repeat(2000),
      });
      expect(created.body).toHaveLength(2000);
    },
  );

  it(
    "create は2001文字の body を拒否しスレッドを増やさない",
    {
      annotation: {
        type: "description",
        description:
          "2001文字の body の create が reject され、ticket 1 のスレッドがシード2件のままであることを検証(上限超過)",
      },
    },
    async () => {
      await expect(
        store.create({
          ticketId: TICKET_1,
          authorEmail: "agent@example.com",
          authorRole: "agent",
          body: "x".repeat(2001),
        }),
      ).rejects.toThrow();
      expect(await store.listByTicket(TICKET_1)).toHaveLength(2);
    },
  );

  it(
    "create は空 body を拒否しスレッドを増やさない",
    {
      annotation: {
        type: "description",
        description:
          "空 body の create が reject され、ticket 1 のスレッドがシード2件のままであることを検証(下限未満)",
      },
    },
    async () => {
      await expect(
        store.create({
          ticketId: TICKET_1,
          authorEmail: "agent@example.com",
          authorRole: "agent",
          body: "",
        }),
      ).rejects.toThrow();
      expect(await store.listByTicket(TICKET_1)).toHaveLength(2);
    },
  );
});

describe("messages schema CHECK constraints @feature-ticket-detail", () => {
  it(
    "raw INSERT でも author_role / body 長の CHECK 制約が拒否する",
    {
      annotation: {
        type: "description",
        description:
          "zod を迂回した直接 INSERT でも messages の CHECK 制約(author_role 列挙・body 長 1..2000)が拒否することを検証",
      },
    },
    async () => {
      const pool = createPool(databaseUrl());
      await applySchemaAndSeed(databaseUrl());
      // Unknown author_role.
      await expect(
        pool.query(
          "INSERT INTO messages (ticket_id, author_email, author_role, body) VALUES ($1, 'x@example.com', 'robot', 'hi')",
          [TICKET_1],
        ),
      ).rejects.toThrow(/check constraint/i);
      // Empty body (below the lower bound).
      await expect(
        pool.query(
          "INSERT INTO messages (ticket_id, author_email, author_role, body) VALUES ($1, 'x@example.com', 'agent', '')",
          [TICKET_1],
        ),
      ).rejects.toThrow(/check constraint/i);
      // 2001-char body (above the upper bound).
      await expect(
        pool.query(
          "INSERT INTO messages (ticket_id, author_email, author_role, body) VALUES ($1, 'x@example.com', 'agent', $2)",
          [TICKET_1, "x".repeat(2001)],
        ),
      ).rejects.toThrow(/check constraint/i);
      await pool.end();
    },
  );

  it(
    "raw INSERT の ticket_id 外部キーは存在しない ticket を拒否する",
    {
      annotation: {
        type: "description",
        description:
          "存在しない ticket_id への直接 INSERT が外部キー制約で拒否されることを検証(参照整合性の最終防衛線)",
      },
    },
    async () => {
      const pool = createPool(databaseUrl());
      await applySchemaAndSeed(databaseUrl());
      await expect(
        pool.query(
          "INSERT INTO messages (ticket_id, author_email, author_role, body) VALUES ($1, 'x@example.com', 'agent', 'orphan')",
          [MISSING_TICKET],
        ),
      ).rejects.toThrow(/foreign key constraint/i);
      await pool.end();
    },
  );
});
