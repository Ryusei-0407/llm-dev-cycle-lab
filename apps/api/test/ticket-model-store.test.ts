import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// ticket-model extends the ticket store (spec: specs/ticket-model.md unit観点).
// The store gains number/assigneeEmail/labels/updatedAt on Ticket, an events
// list on get(), and the mutators setAssignee/setLabels plus a keyset
// listPage. These shapes are the spec's contract; the new methods/fields do not
// exist yet in this branch (RED). db.ts holds the connection helper, store.ts
// exposes createTicketStore(pool) + a named NotFoundError.
import { createPool } from "../src/db.js";
import { createTicketStore, NotFoundError } from "../src/tickets/store.js";
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

// Fixed seed ids/subjects (apps/api/db/seed.sql + specs/ticket-model.md シード).
const TICKET_1 = "00000000-0000-7000-8000-000000000001"; // "Cannot login" → auth, 未割り当て, number 1
const TICKET_2 = "00000000-0000-7000-8000-000000000002"; // "Billing question" → billing, agent@, number 2
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";
const AGENT_EMAIL = "agent@example.com";
const CUSTOMER_EMAIL = "customer@example.com";

describe("ticket-model store: list/get の新フィールド @feature-ticket-model", () => {
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
    "list は number/assigneeEmail/labels(name 昇順)/updatedAt を返す",
    {
      annotation: {
        type: "description",
        description:
          "list の各行が number(連番)・assigneeEmail(未割り当ては null)・labels(name 昇順の Label[])・updatedAt(ISO)を仕様どおり返すことを検証",
      },
    },
    async () => {
      const bySubject = new Map((await store.list()).map((t) => [t.subject, t]));

      const login = bySubject.get("Cannot login to dashboard")!;
      expect(login.number).toBe(1);
      expect(login.assigneeEmail).toBe(null);
      expect(login.labels.map((l) => l.name)).toEqual(["auth"]);
      expect(login.labels[0].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(typeof login.updatedAt).toBe("string");

      const billing = bySubject.get("Billing question")!;
      expect(billing.number).toBe(2);
      expect(billing.assigneeEmail).toBe(AGENT_EMAIL);
      expect(billing.labels.map((l) => l.name)).toEqual(["billing"]);

      const feature = bySubject.get("Feature request: dark mode")!;
      expect(feature.number).toBe(3);
      expect(feature.assigneeEmail).toBe(null);
      expect(feature.labels.map((l) => l.name)).toEqual(["request"]);
    },
  );

  it(
    "get は ticket に number/labels、events を空で返す(未操作のシード)",
    {
      annotation: {
        type: "description",
        description:
          "未操作のシードチケットを get すると ticket に新フィールドが乗り、events は空配列で返ることを検証(履歴は操作で初めて生まれる)",
      },
    },
    async () => {
      const detail = await store.get(TICKET_2);
      expect(detail.ticket.number).toBe(2);
      expect(detail.ticket.assigneeEmail).toBe(AGENT_EMAIL);
      expect(detail.ticket.labels.map((l) => l.name)).toEqual(["billing"]);
      expect(detail.events).toEqual([]);
    },
  );

  it(
    "get は未知の id に NotFoundError を throw する",
    {
      annotation: {
        type: "description",
        description: "存在しない id への get が NotFoundError を throw することを検証",
      },
    },
    async () => {
      await expect(store.get(MISSING_TICKET)).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it(
    "create は既存最大より大きい number を割り当てる(具体値非依存)",
    {
      annotation: {
        type: "description",
        description:
          "create したチケットの number が、生成前の既存 number 最大値より大きいことを検証(4 等の具体値には依存しない)",
      },
    },
    async () => {
      const before = await store.list();
      const maxBefore = Math.max(...before.map((t) => t.number));
      const created = await store.create({
        subject: "Numbered ticket",
        priority: "low",
        requesterEmail: "ops@example.com",
      });
      expect(created.number).toBeGreaterThan(maxBefore);
    },
  );
});

describe("ticket-model store: setAssignee @feature-ticket-model", () => {
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
    "setAssignee は agent メールを割り当て assignee_changed イベントを記録する",
    {
      annotation: {
        type: "description",
        description:
          "未割り当てチケットに agent メールを setAssignee すると assigneeEmail が更新され、assignee_changed イベント(from null → to agent)が記録されることを検証",
      },
    },
    async () => {
      const updated = await store.setAssignee(TICKET_1, AGENT_EMAIL);
      expect(updated.assigneeEmail).toBe(AGENT_EMAIL);

      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("assignee_changed");
      expect(events[0].actorEmail).toBeTruthy();
      expect(events[0].payload).toEqual({ from: null, to: AGENT_EMAIL });
    },
  );

  it(
    "setAssignee(null) は担当を未割り当てに戻しイベントを記録する",
    {
      annotation: {
        type: "description",
        description:
          "担当済みチケット(Billing→agent)に null を setAssignee すると未割り当てに戻り、assignee_changed(from agent → to null)が記録されることを検証",
      },
    },
    async () => {
      const updated = await store.setAssignee(TICKET_2, null);
      expect(updated.assigneeEmail).toBe(null);
      const { events } = await store.get(TICKET_2);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ from: AGENT_EMAIL, to: null });
    },
  );

  it(
    "setAssignee は同値変更をスキップする(イベント・updated_at 不変)",
    {
      annotation: {
        type: "description",
        description:
          "既に agent 担当のチケットへ同じ agent を setAssignee しても、イベントを追加せず updated_at も変えずに成功することを検証(同値スキップ)",
      },
    },
    async () => {
      const before = await store.get(TICKET_2);
      const updated = await store.setAssignee(TICKET_2, AGENT_EMAIL);
      expect(updated.assigneeEmail).toBe(AGENT_EMAIL);
      const after = await store.get(TICKET_2);
      expect(after.events).toHaveLength(0);
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
    },
  );

  it(
    "setAssignee は customer メールを 'not an agent' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "role が agent でない customer メールを setAssignee に渡すと throw し(not an agent)、担当が変わらないことを検証",
      },
    },
    async () => {
      await expect(store.setAssignee(TICKET_1, CUSTOMER_EMAIL)).rejects.toThrow(/not an agent/i);
      const { ticket } = await store.get(TICKET_1);
      expect(ticket.assigneeEmail).toBe(null);
    },
  );

  it(
    "setAssignee は未知メールを 'not an agent' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "users に存在しないメールを setAssignee に渡すと throw し(not an agent)、担当が変わらないことを検証",
      },
    },
    async () => {
      await expect(store.setAssignee(TICKET_1, "ghost@example.com")).rejects.toThrow(
        /not an agent/i,
      );
      const { ticket } = await store.get(TICKET_1);
      expect(ticket.assigneeEmail).toBe(null);
    },
  );

  it(
    "setAssignee は未知の ticket id に NotFoundError を throw する",
    {
      annotation: {
        type: "description",
        description:
          "存在しない ticket id への setAssignee が NotFoundError を throw することを検証",
      },
    },
    async () => {
      await expect(store.setAssignee(MISSING_TICKET, AGENT_EMAIL)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    },
  );

  it(
    "setAssignee は updated_at を単調増加させる",
    {
      annotation: {
        type: "description",
        description:
          "担当変更に成功した際、チケットの updatedAt が変更前より後(単調増加)になることを検証(値そのものではなく増加をアンカー)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await store.setAssignee(TICKET_1, AGENT_EMAIL);
      const after = await store.get(TICKET_1);
      expect(after.ticket.updatedAt >= before.ticket.updatedAt).toBe(true);
      expect(after.ticket.updatedAt).not.toBe(before.ticket.updatedAt);
    },
  );
});

describe("ticket-model store: setLabels @feature-ticket-model", () => {
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
    "setLabels は全置換し labels_changed イベント(from/to 昇順)を記録する",
    {
      annotation: {
        type: "description",
        description:
          "auth ラベルのチケットに [billing, api] を setLabels すると付与が全置換され、labels_changed の payload が from [auth] → to [api, billing](name 昇順)で記録されることを検証",
      },
    },
    async () => {
      const updated = await store.setLabels(TICKET_1, ["billing", "api"]);
      expect(updated.labels.map((l) => l.name)).toEqual(["api", "billing"]);

      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("labels_changed");
      expect(events[0].payload).toEqual({ from: ["auth"], to: ["api", "billing"] });
    },
  );

  it(
    "setLabels の空配列は全ラベルを解除する",
    {
      annotation: {
        type: "description",
        description:
          "setLabels に空配列を渡すと当該チケットのラベルが全解除され、labels_changed(to [])が記録されることを検証",
      },
    },
    async () => {
      const updated = await store.setLabels(TICKET_1, []);
      expect(updated.labels).toEqual([]);
      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ from: ["auth"], to: [] });
    },
  );

  it(
    "setLabels は重複 name を1つに正規化する",
    {
      annotation: {
        type: "description",
        description:
          "同じ name を重複して渡した setLabels が付与を1つに正規化し、二重付与にならないことを検証",
      },
    },
    async () => {
      const updated = await store.setLabels(TICKET_1, ["api", "api"]);
      expect(updated.labels.map((l) => l.name)).toEqual(["api"]);
    },
  );

  it(
    "setLabels はカタログにない name を 'unknown label' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "labels カタログに存在しない name を setLabels に渡すと throw し(unknown label)、付与が変わらないことを検証",
      },
    },
    async () => {
      await expect(store.setLabels(TICKET_1, ["nonexistent"])).rejects.toThrow(/unknown label/i);
      const { ticket } = await store.get(TICKET_1);
      expect(ticket.labels.map((l) => l.name)).toEqual(["auth"]);
    },
  );

  it(
    "setLabels は集合として同値なら何もしない(イベント・updated_at 不変)",
    {
      annotation: {
        type: "description",
        description:
          "現在の付与と集合として同値(順序違い含む)の setLabels は、イベントを追加せず updated_at も変えずに成功することを検証(同値スキップ)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await store.setLabels(TICKET_1, ["auth"]);
      const after = await store.get(TICKET_1);
      expect(after.events).toHaveLength(0);
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
    },
  );

  it(
    "setLabels は未知の ticket id に NotFoundError を throw する",
    {
      annotation: {
        type: "description",
        description: "存在しない ticket id への setLabels が NotFoundError を throw することを検証",
      },
    },
    async () => {
      await expect(store.setLabels(MISSING_TICKET, ["auth"])).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});

describe("ticket-model store: setStatus/reply の履歴・updated_at @feature-ticket-model", () => {
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
    "setStatus は変更時に status_changed イベントを記録する",
    {
      annotation: {
        type: "description",
        description:
          "open のチケットを resolved に setStatus すると status_changed(from open → to resolved)が記録されることを検証",
      },
    },
    async () => {
      await store.setStatus(TICKET_1, "resolved");
      const { events } = await store.get(TICKET_1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("status_changed");
      expect(events[0].payload).toEqual({ from: "open", to: "resolved" });
    },
  );

  it(
    "setStatus は同値(open→open)でイベントを記録しない",
    {
      annotation: {
        type: "description",
        description:
          "現在値と同じ status を setStatus しても status_changed イベントを追加せず updated_at も変えずに成功することを検証(同値スキップ)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1); // TICKET_1 は open
      const updated = await store.setStatus(TICKET_1, "open");
      expect(updated.status).toBe("open");
      const after = await store.get(TICKET_1);
      expect(after.events).toHaveLength(0);
      expect(after.ticket.updatedAt).toBe(before.ticket.updatedAt);
    },
  );

  it(
    "get は events を created_at 昇順で返す(複数操作の時系列)",
    {
      annotation: {
        type: "description",
        description:
          "同一チケットに複数の操作(status→assignee)を順に行うと、get の events が発生順(created_at ASC)で並ぶことを検証",
      },
    },
    async () => {
      await store.setStatus(TICKET_1, "in_progress");
      await store.setAssignee(TICKET_1, AGENT_EMAIL);
      const { events } = await store.get(TICKET_1);
      expect(events.map((e) => e.type)).toEqual(["status_changed", "assignee_changed"]);
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1].createdAt <= events[i].createdAt).toBe(true);
      }
    },
  );

  it(
    "reply 成功後に updated_at が増加する(イベントは記録しない)",
    {
      annotation: {
        type: "description",
        description:
          "reply に成功するとチケットの updatedAt が増加し、かつ履歴(events)は増えないことを検証(reply は履歴対象外)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await store.reply({
        ticketId: TICKET_1,
        authorEmail: AGENT_EMAIL,
        authorRole: "agent",
        body: "Looking into this now.",
      });
      const after = await store.get(TICKET_1);
      expect(after.ticket.updatedAt >= before.ticket.updatedAt).toBe(true);
      expect(after.ticket.updatedAt).not.toBe(before.ticket.updatedAt);
      expect(after.events).toHaveLength(0);
    },
  );
});

describe("ticket-model store: イベントと本体の原子性 @feature-ticket-model", () => {
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
    "setAssignee が失敗したとき本体もイベントも変化しない(トランザクション)",
    {
      annotation: {
        type: "description",
        description:
          "検証で弾かれる setAssignee(customer メール)を発行しても、担当の UPDATE も assignee_changed イベントも一切残らないことを検証(片方だけ残らない=同一トランザクション)",
      },
    },
    async () => {
      await expect(store.setAssignee(TICKET_1, CUSTOMER_EMAIL)).rejects.toThrow();
      const { ticket, events } = await store.get(TICKET_1);
      expect(ticket.assigneeEmail).toBe(null);
      expect(events).toHaveLength(0);
    },
  );

  it(
    "setLabels が失敗したとき本体もイベントも変化しない(トランザクション)",
    {
      annotation: {
        type: "description",
        description:
          "未知 name で弾かれる setLabels を発行しても、ラベルの置換も labels_changed イベントも一切残らないことを検証(同一トランザクション)",
      },
    },
    async () => {
      await expect(store.setLabels(TICKET_1, ["auth", "nonexistent"])).rejects.toThrow();
      const { ticket, events } = await store.get(TICKET_1);
      expect(ticket.labels.map((l) => l.name)).toEqual(["auth"]);
      expect(events).toHaveLength(0);
    },
  );
});
