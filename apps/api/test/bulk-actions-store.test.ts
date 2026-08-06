import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// bulk-actions extends the ticket store with a bulkUpdate mutator (spec:
// specs/bulk-actions.md unit観点). bulkUpdate(ids, patch, actorEmail?) applies
// patch (status? / priority? / assigneeEmail?) to every id in a SINGLE
// transaction and returns { updated } = the count of tickets whose value
// actually changed. It shares the existing single-mutation event / no-op
// contract (setStatus / setPriority / setAssignee): a field left at its current
// value records no event and does not bump updated_at; a real change records the
// matching *_changed event (payload {from, to}, actor = actorEmail) and bumps
// updated_at. If any id is missing, the whole call fails with NotFoundError and
// nothing is applied (rollback). None of this exists yet in this branch (RED).
// db.ts holds the connection helper, store.ts exposes createTicketStore(pool) +
// a named NotFoundError.
import { createPool, type Pool } from "../src/db.js";
import { BadRequestError, createTicketStore, NotFoundError } from "../src/tickets/store.js";
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

// Fixed seed ids/statuses (apps/api/db/seed.sql + specs/ticket-model.md シード)。
// 具体シード値そのものには依存させず、変更前値を get() で読んで from に使うが、
// no-op 混在テストだけは「対象が既に in_progress である1件」を要するので、その
// 前提が崩れたら気付けるようテスト内で assert する。
const TICKET_1 = "00000000-0000-7000-8000-000000000001"; // "Cannot login" → open / high / 未割り当て
const TICKET_2 = "00000000-0000-7000-8000-000000000002"; // "Billing question" → in_progress / medium / agent@
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";
const AGENT_EMAIL = "agent@example.com";

describe("bulk-actions store: bulkUpdate @feature-bulk-actions", () => {
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
    "2件を status 変更すると updated=2・各チケットに status_changed が1件ずつ記録される",
    {
      annotation: {
        type: "description",
        description:
          "2件がともに現在値と異なる status になる patch を bulkUpdate すると updated=2 が返り、両チケットに status_changed イベント(payload from→to、actor=渡した email)が1件ずつ記録され updated_at が bump されることを検証",
      },
    },
    async () => {
      const before1 = await store.get(TICKET_1);
      const before2 = await store.get(TICKET_2);
      // 両方とも resolved にする(TICKET_1=open, TICKET_2=in_progress のため実変更)。
      expect(before1.ticket.status).not.toBe("resolved");
      expect(before2.ticket.status).not.toBe("resolved");

      const result = await store.bulkUpdate(
        [TICKET_1, TICKET_2],
        { status: "resolved" },
        AGENT_EMAIL,
      );
      expect(result.updated).toBe(2);

      for (const [id, before] of [
        [TICKET_1, before1],
        [TICKET_2, before2],
      ] as const) {
        const after = await store.get(id);
        expect(after.ticket.status).toBe("resolved");
        expect(after.events).toHaveLength(1);
        expect(after.events[0].type).toBe("status_changed");
        expect(after.events[0].actorEmail).toBe(AGENT_EMAIL);
        expect(after.events[0].payload).toEqual({ from: before.ticket.status, to: "resolved" });
        expect(after.ticket.updatedAt).not.toBe(before.ticket.updatedAt);
      }
    },
  );

  it(
    "同値が混じると updated=1・no-op 側はイベント無し + updated_at 据え置き",
    {
      annotation: {
        type: "description",
        description:
          "対象2件のうち1件が既に patch と同値(in_progress)である status:in_progress を bulkUpdate すると updated=1 が返り、実変更した側だけに status_changed が記録され、同値側はイベント無し・updated_at 据え置き(no-op)であることを検証",
      },
    },
    async () => {
      const before1 = await store.get(TICKET_1); // open(実変更される)
      const before2 = await store.get(TICKET_2); // in_progress(同値 no-op)
      expect(before1.ticket.status).not.toBe("in_progress");
      expect(before2.ticket.status).toBe("in_progress");

      const result = await store.bulkUpdate(
        [TICKET_1, TICKET_2],
        { status: "in_progress" },
        AGENT_EMAIL,
      );
      // 実際に値が変わったのは TICKET_1 の1件だけ。
      expect(result.updated).toBe(1);

      const after1 = await store.get(TICKET_1);
      expect(after1.ticket.status).toBe("in_progress");
      expect(after1.events).toHaveLength(1);
      expect(after1.events[0].type).toBe("status_changed");
      expect(after1.ticket.updatedAt).not.toBe(before1.ticket.updatedAt);

      const after2 = await store.get(TICKET_2);
      expect(after2.events).toHaveLength(0);
      expect(after2.ticket.updatedAt).toBe(before2.ticket.updatedAt);
    },
  );

  it(
    "不在 id が1つでも混じると NotFoundError で全件据え置き(rollback)",
    {
      annotation: {
        type: "description",
        description:
          "存在する id と存在しない id を混ぜて bulkUpdate すると NotFoundError が throw され、実在した側にも一切変更が適用されない(status も updated_at もイベントも据え置き=単一トランザクションで rollback)ことを検証",
      },
    },
    async () => {
      const before1 = await store.get(TICKET_1);
      expect(before1.ticket.status).not.toBe("resolved");

      await expect(
        store.bulkUpdate([TICKET_1, MISSING_TICKET], { status: "resolved" }, AGENT_EMAIL),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 実在した TICKET_1 も巻き戻り、変更前と完全一致する。
      const after1 = await store.get(TICKET_1);
      expect(after1.ticket.status).toBe(before1.ticket.status);
      expect(after1.ticket.updatedAt).toBe(before1.ticket.updatedAt);
      expect(after1.events).toHaveLength(0);
    },
  );

  it(
    "assigneeEmail: null で担当解除し assignee_changed を記録する",
    {
      annotation: {
        type: "description",
        description:
          "担当者が設定済み(agent@)のチケットに assigneeEmail:null を bulkUpdate すると担当が解除され(assigneeEmail=null)、updated=1・assignee_changed イベント(payload from=agent@ → to=null)が記録されることを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_2); // agent@ が担当
      expect(before.ticket.assigneeEmail).toBe(AGENT_EMAIL);

      const result = await store.bulkUpdate([TICKET_2], { assigneeEmail: null }, AGENT_EMAIL);
      expect(result.updated).toBe(1);

      const after = await store.get(TICKET_2);
      expect(after.ticket.assigneeEmail).toBeNull();
      expect(after.events).toHaveLength(1);
      expect(after.events[0].type).toBe("assignee_changed");
      expect(after.events[0].payload).toEqual({ from: AGENT_EMAIL, to: null });
      expect(after.ticket.updatedAt).not.toBe(before.ticket.updatedAt);
    },
  );

  it(
    "全件が同値の bulkUpdate は updated=0・イベント無し",
    {
      annotation: {
        type: "description",
        description:
          "対象全件が既に patch と同値である bulkUpdate は成功するが updated=0 を返し、どのチケットにもイベントを追加せず updated_at も据え置くことを検証(全件 no-op)",
      },
    },
    async () => {
      const before1 = await store.get(TICKET_1);
      const before2 = await store.get(TICKET_2);
      // 各チケットの現在 status をそのまま patch すると全件 no-op になる… が bulk の
      // patch は単一なので、両方に共通の同値を作れない。ここでは TICKET_2 の現在値
      // (in_progress)を patch にし、既に in_progress の TICKET_2 単体で no-op を見る。
      expect(before2.ticket.status).toBe("in_progress");

      const result = await store.bulkUpdate([TICKET_2], { status: "in_progress" }, AGENT_EMAIL);
      expect(result.updated).toBe(0);

      const after2 = await store.get(TICKET_2);
      expect(after2.events).toHaveLength(0);
      expect(after2.ticket.updatedAt).toBe(before2.ticket.updatedAt);
      // before1 は触れていないので参照だけ(未使用変数回避)。
      expect(before1.ticket.id).toBe(TICKET_1);
    },
  );
  it(
    "反証固定: priority の一括変更が適用され priority_changed が記録される",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反証固定: patch.priority を送るテストが皆無で priority ブランチを無効化しても全テストが素通りした。bulkUpdate([id],{priority:'low'}) で priority が書き変わり updated=1・priority_changed(payload from→to)が記録されることを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      expect(before.ticket.priority).not.toBe("low");

      const result = await store.bulkUpdate([TICKET_1], { priority: "low" }, AGENT_EMAIL);
      expect(result.updated).toBe(1);

      const after = await store.get(TICKET_1);
      expect(after.ticket.priority).toBe("low");
      expect(after.events).toHaveLength(1);
      expect(after.events[0].type).toBe("priority_changed");
      expect(after.events[0].payload).toEqual({ from: before.ticket.priority, to: "low" });
    },
  );

  it(
    "反証固定: 非 agent の assigneeEmail は BadRequestError(書き込まれない)",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反証固定: agent 存在チェックを無効化しても全テストが素通りした(assignee_email に FK は無く不正メールが黙って書ける)。customer メールを assigneeEmail に bulkUpdate すると BadRequestError で全体が失敗し、チケットが据え置かれることを検証",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      await expect(
        store.bulkUpdate([TICKET_1], { assigneeEmail: "customer@example.com" }, AGENT_EMAIL),
      ).rejects.toBeInstanceOf(BadRequestError);
      const after = await store.get(TICKET_1);
      expect(after.ticket.assigneeEmail).toBe(before.ticket.assigneeEmail);
      expect(after.events).toHaveLength(0);
    },
  );

  it(
    "反証固定: 多フィールド patch はフィールド毎のイベントを出しつつ updated=1",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反証固定: {status, priority} を同一 patch で送るケースが皆無だった。両方が実変更のとき status_changed と priority_changed が1件ずつ記録され、updated はチケット単位の 1 であることを検証(フィールド数でなくチケット数を数える)",
      },
    },
    async () => {
      const before = await store.get(TICKET_1);
      expect(before.ticket.status).not.toBe("resolved");
      expect(before.ticket.priority).not.toBe("low");

      const result = await store.bulkUpdate(
        [TICKET_1],
        { status: "resolved", priority: "low" },
        AGENT_EMAIL,
      );
      expect(result.updated).toBe(1);

      const after = await store.get(TICKET_1);
      expect(after.ticket.status).toBe("resolved");
      expect(after.ticket.priority).toBe("low");
      expect(after.events.map((e) => e.type).sort()).toEqual([
        "priority_changed",
        "status_changed",
      ]);
    },
  );
});
