import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RealtimeEvent, RealtimeHub } from "../src/realtime.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// bulk-actions router surface (spec: specs/bulk-actions.md 公開インターフェース).
// tickets.bulkUpdate is session-required + agent-only: unauthenticated →
// UNAUTHORIZED, customer → FORBIDDEN. On success it returns { updated } and
// broadcasts one { type: "ticket.updated", ticketId } per *actually-changed*
// ticket (no broadcast for a no-op ticket). Verified on the public HTTP面 only
// (login → sid cookie → /api/rpc/tickets/bulkUpdate), the same contract-testing
// idiom as set-priority-router.test.ts; broadcast observation reuses the
// createApp({ hub }) injection idiom (no socket). The procedure does not exist
// yet in this branch (RED).

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

// Fixed seed ids/statuses (specs/ticket-model.md シード)。
const TICKET_1 = "00000000-0000-7000-8000-000000000001"; // open / high / 未割り当て
const TICKET_2 = "00000000-0000-7000-8000-000000000002"; // in_progress / medium / agent@

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

function rpc(
  app: ReturnType<typeof createApp>,
  procedure: string,
  input: unknown,
  cookie?: string,
) {
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

// 現在の status を get 手続きで読む(シードの具体値に依存せず patch を派生する)。
async function statusOf(
  app: ReturnType<typeof createApp>,
  id: string,
  cookie: string,
): Promise<"open" | "in_progress" | "resolved"> {
  const res = await rpc(app, "get", { id }, cookie);
  expect(res.status).toBe(200);
  const detail = unwrap(await res.json()) as {
    ticket: { status: "open" | "in_progress" | "resolved" };
  };
  return detail.ticket.status;
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

describe("bulk-actions: bulkUpdate はエージェント専用 (HTTP面) @feature-bulk-actions", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未認証の bulkUpdate は UNAUTHORIZED(401)",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの bulkUpdate が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(セッション必須)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "bulkUpdate", {
        ids: [TICKET_1],
        patch: { status: "resolved" },
      });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "customer の bulkUpdate は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が bulkUpdate を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(bulkUpdate は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(
        app,
        "bulkUpdate",
        { ids: [TICKET_1], patch: { status: "resolved" } },
        cookie,
      );
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の bulkUpdate は成功し実変更した件数を updated で返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が2件を現在値と異なる status に bulkUpdate すると HTTP 200 で { updated: 2 } が返ることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const s1 = await statusOf(app, TICKET_1, cookie);
      const s2 = await statusOf(app, TICKET_2, cookie);
      // 両方が resolved でないシード前提(実変更2件を作れる)。
      expect(s1).not.toBe("resolved");
      expect(s2).not.toBe("resolved");

      const res = await rpc(
        app,
        "bulkUpdate",
        { ids: [TICKET_1, TICKET_2], patch: { status: "resolved" } },
        cookie,
      );
      expect(res.status).toBe(200);
      const out = unwrap(await res.json()) as { updated: number };
      expect(out.updated).toBe(2);
    },
  );

  it(
    "agent の bulkUpdate は不在 id 混在で NOT_FOUND(404)",
    {
      annotation: {
        type: "description",
        description:
          "agent が実在 id と存在しない id を混ぜて bulkUpdate すると HTTP 404 + oRPC code NOT_FOUND になることを検証(全体 rollback の HTTP 面)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "bulkUpdate",
        {
          ids: [TICKET_1, "00000000-0000-7000-8000-0000000000ff"],
          patch: { status: "resolved" },
        },
        cookie,
      );
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );

  it(
    "agent の bulkUpdate は空 patch を BAD_REQUEST(400)で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が patch 空オブジェクトの bulkUpdate を送ると入力検証(zod .refine)で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "bulkUpdate", { ids: [TICKET_1], patch: {} }, cookie);
      expect(res.status).toBe(400);
    },
  );
});

describe("bulk-actions: bulkUpdate のブロードキャスト (HTTP面) @feature-bulk-actions", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "実変更したチケットの分だけ ticket.updated を配信する(no-op は配信しない)",
    {
      annotation: {
        type: "description",
        description:
          "既に in_progress の TICKET_2 を含む2件へ status:in_progress を bulkUpdate すると、実変更した TICKET_1 の ticket.updated だけが1件配信され、同値 no-op の TICKET_2 分は配信されないことを検証(録音 hub 注入)",
      },
    },
    async () => {
      const hub = recordingHub();
      const app = createApp({ hub });
      const cookie = await cookieFor(app, SEED.agent);
      // TICKET_1=open(実変更), TICKET_2=in_progress(同値 no-op)のシード前提。
      expect(await statusOf(app, TICKET_1, cookie)).not.toBe("in_progress");
      expect(await statusOf(app, TICKET_2, cookie)).toBe("in_progress");

      const res = await rpc(
        app,
        "bulkUpdate",
        { ids: [TICKET_1, TICKET_2], patch: { status: "in_progress" } },
        cookie,
      );
      expect(res.status).toBe(200);
      // 実変更は TICKET_1 のみ → その1件だけ配信。TICKET_2(no-op)は配信されない。
      expect(hub.events).toEqual([{ type: "ticket.updated", ticketId: TICKET_1 }]);
    },
  );
});
