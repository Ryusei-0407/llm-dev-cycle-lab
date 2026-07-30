import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createRealtimeHub, type RealtimeEvent, type RealtimeHub } from "../src/realtime.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// RED spec: specs/ws-realtime.md. ws-realtime broadcasts ticket changes over a
// WebSocket hub. This file pins two contracts:
//   1. createRealtimeHub() — the in-memory connection set (register / broadcast
//      / size + dead-socket eviction). Pure logic, no real WS: exercised with
//      minimal mock sockets.
//   2. broadcast firing — create / setStatus / reply, driven over the real HTTP
//      (oRPC) surface, push the matching event into an *injected* hub. The hub
//      is injected via createApp({ hub }) so the test can observe what the
//      router broadcasts without opening a socket.
//
// 予想している公開契約(実装未読・報告に明記):
//   - src/realtime.ts exports createRealtimeHub(): RealtimeHub and the
//     RealtimeEvent / RealtimeHub types.
//   - RealtimeHub = { register(ws): void; broadcast(event): void; size(): number }.
//   - register(ws) takes a minimal socket with send(data: string) and a
//     readyState (ws OPEN === 1). broadcast(event) serialises the event to JSON
//     and calls ws.send on every live socket; a socket whose send throws (or
//     which is not OPEN) is evicted from the set (size() drops).
//   - createApp() gains an optional injection seam createApp({ hub }): the
//     tickets router broadcasts through this hub after a successful mutation.
//     Default (no arg) constructs a real hub, so existing createApp() callers
//     are unaffected. draft(=下書き) does NOT broadcast.

// 最小モックソケット: ws OPEN(readyState 1)。send は spy。
const WS_OPEN = 1;
const WS_CLOSED = 3;
function mockSocket(readyState: number = WS_OPEN) {
  return { readyState, send: vi.fn() };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
} as const;

function login(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sidFrom(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
}

async function agentCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await login(app, SEED.agent);
  expect(res.status).toBe(200);
  const sid = sidFrom(res);
  expect(sid).toBeTruthy();
  return `sid=${sid}`;
}

function rpc(app: ReturnType<typeof createApp>, proc: string, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request(`/api/rpc/tickets/${proc}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
  });
}

function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "json" in (body as Record<string, unknown>)) {
    return (body as { json: unknown }).json;
  }
  return body;
}

// A fake hub whose broadcast records every event, so an HTTP-surface mutation
// can be asserted against the exact { type, ticketId } payload the router emits.
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

describe("createRealtimeHub (unit) @feature-ws-realtime", () => {
  it(
    "registers sockets and broadcasts the serialised event to each",
    {
      annotation: {
        type: "description",
        description:
          "register した全ソケットに broadcast がイベントを JSON 文字列で送り、size() が接続数を返すことを検証",
      },
    },
    () => {
      const hub = createRealtimeHub();
      const a = mockSocket();
      const b = mockSocket();
      hub.register(a);
      hub.register(b);
      expect(hub.size()).toBe(2);

      const event: RealtimeEvent = { type: "ticket.created", ticketId: "t-1" };
      hub.broadcast(event);

      expect(a.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(b.send).toHaveBeenCalledWith(JSON.stringify(event));
    },
  );

  it(
    "evicts a socket that fails to send so later broadcasts skip it",
    {
      annotation: {
        type: "description",
        description:
          "send が例外を投げる(切断済み)ソケットは broadcast 時に集合から除去され、size() が減り以降の broadcast 対象から外れることを検証",
      },
    },
    () => {
      const hub = createRealtimeHub();
      const live = mockSocket();
      const dead = mockSocket();
      dead.send.mockImplementation(() => {
        throw new Error("socket closed");
      });
      hub.register(live);
      hub.register(dead);
      expect(hub.size()).toBe(2);

      hub.broadcast({ type: "ticket.updated", ticketId: "t-2" });
      // 死んだソケットは除去され、生きたソケットは受信を続ける。
      expect(hub.size()).toBe(1);

      live.send.mockClear();
      hub.broadcast({ type: "ticket.updated", ticketId: "t-3" });
      expect(dead.send).toHaveBeenCalledTimes(1); // 2回目は対象外
      expect(live.send).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "does not broadcast to a socket that is already closed",
    {
      annotation: {
        type: "description",
        description:
          "readyState が OPEN でない(closed)ソケットへは broadcast が send せず、集合からも除去されることを検証",
      },
    },
    () => {
      const hub = createRealtimeHub();
      const closed = mockSocket(WS_CLOSED);
      hub.register(closed);

      hub.broadcast({ type: "message.created", ticketId: "t-4" });

      expect(closed.send).not.toHaveBeenCalled();
      expect(hub.size()).toBe(0);
    },
  );
});

describe("ws-realtime broadcast firing (HTTP面) @feature-ws-realtime", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "broadcasts ticket.created after a successful create",
    {
      annotation: {
        type: "description",
        description:
          "認証済み tickets.create の成功後に、注入した hub が新チケットの id を持つ ticket.created を1件受信することを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);

      const res = await rpc(app, "create", { subject: "WS create", priority: "medium" }, cookie);
      expect(res.status).toBe(200);
      const created = unwrap(await res.json()) as { id: string };

      expect(hub.events).toEqual([{ type: "ticket.created", ticketId: created.id }]);
    },
  );

  it(
    "broadcasts ticket.updated after a successful setStatus",
    {
      annotation: {
        type: "description",
        description:
          "agent の tickets.setStatus 成功後に、注入した hub が対象チケット id の ticket.updated を受信することを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);

      const createRes = await rpc(app, "create", { subject: "WS status", priority: "low" }, cookie);
      const created = unwrap(await createRes.json()) as { id: string };
      hub.events.length = 0; // create の分は捨て、setStatus 由来だけを見る

      const res = await rpc(app, "setStatus", { id: created.id, status: "in_progress" }, cookie);
      expect(res.status).toBe(200);

      expect(hub.events).toEqual([{ type: "ticket.updated", ticketId: created.id }]);
    },
  );

  it(
    "broadcasts message.created after a successful reply",
    {
      annotation: {
        type: "description",
        description:
          "tickets.reply 成功後に、注入した hub が対象チケット id の message.created を受信することを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await agentCookie(app);

      const createRes = await rpc(app, "create", { subject: "WS reply", priority: "low" }, cookie);
      const created = unwrap(await createRes.json()) as { id: string };
      hub.events.length = 0;

      const res = await rpc(app, "reply", { ticketId: created.id, body: "on it" }, cookie);
      expect(res.status).toBe(200);

      expect(hub.events).toEqual([{ type: "message.created", ticketId: created.id }]);
    },
  );
});
