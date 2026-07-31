import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RealtimeEvent, RealtimeHub } from "../src/realtime.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// spec: specs/ticket-model.md — setAssignee / setLabels は「変更成功時に
// ticket.updated をブロードキャスト、同値なら配信なし」。テスト先行分の
// 未カバー注記(配信面)をここで固定する。観測は realtime.test.ts と同じ
// createApp({ hub }) 注入イディオム(ソケット不要)。

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
} as const;

// customer 所有・未割り当て・auth ラベルのシードチケット(seed.sql)。
const TICKET_1 = "00000000-0000-7000-8000-000000000001";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

function login(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function agentCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await login(app, SEED.agent);
  expect(res.status).toBe(200);
  const sid = res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
  expect(sid).toBeTruthy();
  return `sid=${sid}`;
}

function rpc(app: ReturnType<typeof createApp>, proc: string, input: unknown, cookie: string) {
  return app.request(`/api/rpc/tickets/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: input }),
  });
}

function recordingHub(): RealtimeHub & { events: RealtimeEvent[] } {
  const events: RealtimeEvent[] = [];
  return {
    events,
    register: () => {},
    broadcast: (event: RealtimeEvent) => {
      events.push(event);
    },
    size: () => 0,
  };
}

describe("ticket-model broadcast @feature-ticket-model", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "setAssignee の変更成功は ticket.updated を1件配信する",
    {
      annotation: {
        type: "description",
        description:
          "未割り当てのシードチケットへ setAssignee(agent) すると { type: 'ticket.updated', ticketId } が1件だけ配信されることを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);
      const res = await rpc(
        app,
        "setAssignee",
        { id: TICKET_1, assigneeEmail: SEED.agent.email },
        cookie,
      );
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([{ type: "ticket.updated", ticketId: TICKET_1 }]);
    },
  );

  it(
    "setAssignee の同値(null→null)は配信しない",
    {
      annotation: {
        type: "description",
        description:
          "未割り当てチケットへの setAssignee(null) は成功するが、同値のためブロードキャストが発生しないことを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);
      const res = await rpc(app, "setAssignee", { id: TICKET_1, assigneeEmail: null }, cookie);
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([]);
    },
  );

  it(
    "setLabels の変更成功は ticket.updated を1件配信する",
    {
      annotation: {
        type: "description",
        description:
          "auth ラベルのシードチケットを setLabels(['billing']) で置換すると ticket.updated が1件だけ配信されることを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);
      const res = await rpc(app, "setLabels", { id: TICKET_1, labels: ["billing"] }, cookie);
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([{ type: "ticket.updated", ticketId: TICKET_1 }]);
    },
  );

  it(
    "setLabels の集合同値は配信しない",
    {
      annotation: {
        type: "description",
        description:
          "現在の付与(auth)と同じ集合を setLabels に渡すと成功するが、同値のためブロードキャストが発生しないことを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);
      const res = await rpc(app, "setLabels", { id: TICKET_1, labels: ["auth"] }, cookie);
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([]);
    },
  );
});
