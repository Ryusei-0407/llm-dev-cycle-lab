import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RealtimeEvent, RealtimeHub } from "../src/realtime.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// set-priority router surface (spec: specs/set-priority.md サーバー / router観点).
// Verified on the public HTTP面 only (login → sid cookie → /api/rpc/tickets/
// setPriority), the same contract-testing idiom as ticket-model-router.test.ts
// (login/sidFrom/rpc/unwrap helpers). Broadcast observation reuses the
// createApp({ hub }) injection idiom from ticket-model-broadcast.test.ts (no
// socket). The procedure does not exist yet in this branch (RED).
//
// setPriority は agent 専用: customer は FORBIDDEN、未認証は UNAUTHORIZED、不在は
// NOT_FOUND。変更成功時のみ ticket.updated を1件配信し、同値は配信しない。

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

const CUSTOMER_TICKET = "00000000-0000-7000-8000-000000000001"; // customer 所有・auth
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

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

function sidFrom(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
}

async function cookieFor(
  app: ReturnType<typeof createApp>,
  seed: { email: string; password: string },
): Promise<string> {
  const res = await login(app, seed);
  expect(res.status).toBe(200);
  const sid = sidFrom(res);
  expect(sid).toBeTruthy();
  return `sid=${sid}`;
}

function rpc(app: ReturnType<typeof createApp>, procedure: string, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request(`/api/rpc/tickets/${procedure}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
  });
}

// oRPC の json 封筒を吸収する: {"json": x} なら x を、素の x ならそのまま返す。
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "json" in (body as Record<string, unknown>)) {
    return (body as { json: unknown }).json;
  }
  return body;
}

// 現在の優先度を get 手続きで読む。シードの具体値に依存せず、from/to を派生する
// (同値抑止テストは現在値を、変更テストは現在値と異なる値を送る)。
async function priorityOf(
  app: ReturnType<typeof createApp>,
  id: string,
  cookie: string,
): Promise<"low" | "medium" | "high"> {
  const res = await rpc(app, "get", { id }, cookie);
  expect(res.status).toBe(200);
  const detail = unwrap(await res.json()) as { ticket: { priority: "low" | "medium" | "high" } };
  return detail.ticket.priority;
}

function otherPriority(current: "low" | "medium" | "high"): "low" | "medium" | "high" {
  return current === "high" ? "low" : "high";
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

describe("set-priority: setPriority はエージェント専用 (HTTP面) @feature-set-priority", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未認証の setPriority は UNAUTHORIZED(401)",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの setPriority が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "setPriority", { id: CUSTOMER_TICKET, priority: "high" });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "customer の setPriority は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が setPriority を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(setPriority は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "setPriority", { id: CUSTOMER_TICKET, priority: "high" }, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の setPriority は成功し更新後の priority を持つ Ticket を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が現在値と異なる優先度に setPriority すると HTTP 200 で priority 反映後の Ticket が返ることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const to = otherPriority(await priorityOf(app, CUSTOMER_TICKET, cookie));
      const res = await rpc(app, "setPriority", { id: CUSTOMER_TICKET, priority: to }, cookie);
      expect(res.status).toBe(200);
      const ticket = unwrap(await res.json()) as { priority: string };
      expect(ticket.priority).toBe(to);
    },
  );

  it(
    "agent の setPriority は不在チケットに NOT_FOUND(404)",
    {
      annotation: {
        type: "description",
        description:
          "agent が存在しない id に setPriority すると HTTP 404 + oRPC code NOT_FOUND になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "setPriority", { id: MISSING_TICKET, priority: "high" }, cookie);
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );

  it(
    "agent の setPriority は enum 外の priority を BAD_REQUEST(400)で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が low/medium/high 以外の priority を setPriority に渡すと入力検証(zod)で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "setPriority", { id: CUSTOMER_TICKET, priority: "urgent" }, cookie);
      expect(res.status).toBe(400);
    },
  );
});

describe("set-priority: setPriority のブロードキャスト (HTTP面) @feature-set-priority", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "setPriority の変更成功は ticket.updated を1件配信する",
    {
      annotation: {
        type: "description",
        description:
          "agent が現在値と異なる優先度に setPriority すると { type: 'ticket.updated', ticketId } が1件だけ配信されることを検証",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await cookieFor(app, SEED.agent);
      const to = otherPriority(await priorityOf(app, CUSTOMER_TICKET, cookie));
      const res = await rpc(app, "setPriority", { id: CUSTOMER_TICKET, priority: to }, cookie);
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([{ type: "ticket.updated", ticketId: CUSTOMER_TICKET }]);
    },
  );

  it(
    "setPriority の同値変更は配信しない",
    {
      annotation: {
        type: "description",
        description:
          "現在値と同じ優先度を setPriority すると成功するが、同値のためブロードキャストが発生しないことを検証(setStatus と同じ同値抑止)",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await cookieFor(app, SEED.agent);
      const same = await priorityOf(app, CUSTOMER_TICKET, cookie);
      const res = await rpc(app, "setPriority", { id: CUSTOMER_TICKET, priority: same }, cookie);
      expect(res.status).toBe(200);
      expect(hub.events).toEqual([]);
    },
  );
});
