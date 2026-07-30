import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// reply-draft (spec: specs/reply-draft.md) exposes POST /api/tickets/draft, a
// Hono route (not oRPC) that reads a ticket + its thread, builds a support-agent
// prompt, and streams the LLM reply draft as SSE. These tests exercise the
// public HTTP surface only — auth, zod, not-found, and the deterministic mock
// adapter's fixed output — never the internal module layout (RED: the route
// does not exist yet on this branch). The mock adapter echoes the ticket
// subject into its fixed line, so a subject appearing in the stream is the
// indirect check that prompt assembly read the right ticket.

// Fixed seed from apps/api/db/seed.sql: ticket 1 = "Cannot login to dashboard".
const TICKET_1 = "00000000-0000-7000-8000-000000000001";
const TICKET_1_SUBJECT = "Cannot login to dashboard";
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
} as const;

// DATABASE_URL comes from the vitest globalSetup (apps/api/test/global-setup.ts),
// which provisions/resets a temp DB. Never hardcode a connection string here
// (POLICY.md §共通規約: 接続情報をテストコードに書かない).
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

// Hono's app.request has no cookie jar, so pull the sid out of Set-Cookie and
// present it on follow-up requests (same helper as auth-route/session-requester).
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

function draft(app: ReturnType<typeof createApp>, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/tickets/draft", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/tickets/draft @feature-reply-draft", () => {
  beforeAll(() => {
    // Deterministic mock adapter: keep any streaming delay at zero so text()
    // reads the whole body without arbitrary waits (mirrors chat-route.test.ts).
    process.env.MOCK_DELAY_MS = "0";
  });

  // The route reads the seeded ticket + thread, so reset schema + seed before
  // each case to keep tests isolated from one another (ticket-messages.test.ts
  // と同じ分離方針)。
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未認証(cookie 無し)の draft は 401 で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの POST /api/tickets/draft が HTTP 401 で拒否され、ストリームを開始しないことを検証",
      },
    },
    async () => {
      const res = await draft(createApp(), { ticketId: TICKET_1 });
      expect(res.status).toBe(401);
    },
  );

  it(
    "存在しない ticketId の draft は 404 を返す",
    {
      annotation: {
        type: "description",
        description:
          "認証済みでも存在しない ticketId への draft が HTTP 404 を返すことを検証(ticket 不在)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentCookie(app);
      const res = await draft(app, { ticketId: MISSING_TICKET }, cookie);
      expect(res.status).toBe(404);
    },
  );

  it(
    "不正 body(ticketId 欠落)の draft は zod で 400 を返す",
    {
      annotation: {
        type: "description",
        description:
          "ticketId を欠いた不正 body の draft が zod 検証で HTTP 400 を返すことを検証(バリデーション)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentCookie(app);
      const res = await draft(app, {}, cookie);
      expect(res.status).toBe(400);
    },
  );

  it(
    "不正 body(ticketId が UUID でない)の draft は zod で 400 を返す",
    {
      annotation: {
        type: "description",
        description:
          "UUID でない ticketId の draft が zod 検証で HTTP 400 を返すことを検証(型不一致の境界)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentCookie(app);
      const res = await draft(app, { ticketId: "not-a-uuid" }, cookie);
      expect(res.status).toBe(400);
    },
  );

  it(
    "認証済みの draft は mock アダプタの固定文を SSE で返す",
    {
      annotation: {
        type: "description",
        description:
          'agent ログイン + 実在シード ticketId への draft が text/event-stream で 200 を返し、mock アダプタの固定文要素("Draft reply for" とチケット主題)がストリーム本文に含まれることを検証',
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentCookie(app);
      const res = await draft(app, { ticketId: TICKET_1 }, cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      // Read the full SSE body at once (chat-route.test.ts の流儀)。
      const text = await res.text();
      // Fixed line format from spec: Draft reply for "{subject}": Thanks ...
      expect(text).toContain("Draft reply for");
      // Indirect prompt check: the mock echoes the ticket's subject, so its
      // presence proves the route read the right ticket into the prompt.
      expect(text).toContain(TICKET_1_SUBJECT);
    },
  );
});

describe("draft prompt assembly @feature-reply-draft", () => {
  it(
    "includes the subject and every thread message body in the prompt",
    {
      annotation: {
        type: "description",
        description:
          "ドラフト生成プロンプトに件名とスレッド全メッセージの本文が含まれることを直接検証(会話文脈の中核保証)",
      },
    },
    async () => {
      const { buildDraftMessages } = await import("../src/tickets/draft.js");
      const ticket = {
        subject: "Cannot login to dashboard",
        status: "open",
        priority: "high",
        requesterEmail: "customer@example.com",
      };
      const thread = [
        {
          authorRole: "customer",
          authorEmail: "customer@example.com",
          body: "It says invalid credentials.",
        },
        {
          authorRole: "agent",
          authorEmail: "agent@example.com",
          body: "Did you change your password?",
        },
      ];
      const messages = buildDraftMessages(ticket as never, thread as never);
      const content = messages.map((m) => m.content).join("\n");
      expect(content).toContain(ticket.subject);
      for (const message of thread) {
        expect(content).toContain(message.body);
      }
    },
  );
});
