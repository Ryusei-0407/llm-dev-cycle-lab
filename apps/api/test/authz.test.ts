import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// authz (spec: specs/authz.md) はチケット API のロール別認可を router 層(+ draft
// route)で行う。検証は公開 HTTP 面のみ(/api/auth/login → sid cookie 付き
// /api/rpc/tickets/*、および POST /api/tickets/draft)で行い、内部モジュールには
// 触れない。auth-route / session-requester / reply-draft と同じ「契約をテストする」
// 流儀(login/sidFrom/rpc*/unwrap ヘルパーを踏襲)。
//
// シード事情(apps/api/db/seed.sql):チケット3件はすべて requesterEmail =
// customer@example.com(= シード customer 所有)。ユーザーは in-memory の2名のみ
// (specs/auth.md)。よって「他人のチケット」は、agent セッションで create した
// requesterEmail = agent@example.com のチケットを使う(customer-portal 仕様と同じ
// 準備方針:シードは変更しない)。

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

// 3件のシードチケットのうち1件(customer 所有)。get / reply の「自分のチケット」経路と、
// setStatus の agent 成功経路で使う。
const CUSTOMER_TICKET = "00000000-0000-7000-8000-000000000001";
const CUSTOMER_TICKET_SUBJECT = "Cannot login to dashboard";
// 存在しないチケット(認可より存在確認が先 → NOT_FOUND のままであることの検証用)。
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

// DATABASE_URL は vitest globalSetup(apps/api/test/global-setup.ts)が一時DBを
// 供給する前提。接続文字列はここにハードコードしない(POLICY.md §共通規約)。
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

// Hono の app.request には cookie jar が無いので、Set-Cookie から sid を取り出して
// 後続リクエストに手で載せる(auth-route / session-requester と同じヘルパー)。
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

function draft(app: ReturnType<typeof createApp>, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/tickets/draft", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
}

// oRPC の json 封筒を吸収する: {"json": x} なら x を、素の x ならそのまま返す。
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "json" in (body as Record<string, unknown>)) {
    return (body as { json: unknown }).json;
  }
  return body;
}

// agent セッションで requesterEmail = agent@example.com のチケットを1件作り、その id を返す。
// これが customer から見た「他人のチケット」。シードは触らないので他テストへ波及しない。
async function createAgentTicket(
  app: ReturnType<typeof createApp>,
  agentCookie: string,
  subject: string,
): Promise<string> {
  const res = await rpc(app, "create", { subject, priority: "medium" }, agentCookie);
  expect(res.status).toBe(200);
  const created = unwrap(await res.json()) as { id: string; requesterEmail: string };
  expect(created.requesterEmail).toBe(SEED.agent.email);
  expect(created.id).toBeTruthy();
  return created.id;
}

describe("authz: 未認証は全手続き 401 (HTTP面) @feature-authz", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "cookie 無しの list は 401 UNAUTHORIZED で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの tickets.list が HTTP 401 + oRPC エラー code UNAUTHORIZED で拒否されることを検証(list も認可必須に変更)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "list", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "cookie 無しの get は 401 UNAUTHORIZED で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの tickets.get が HTTP 401 + oRPC エラー code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "get", { id: CUSTOMER_TICKET });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "cookie 無しの reply は 401 UNAUTHORIZED で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの tickets.reply が HTTP 401 + oRPC エラー code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "reply", { ticketId: CUSTOMER_TICKET, body: "anon?" });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "cookie 無しの setStatus は 401 UNAUTHORIZED で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの tickets.setStatus が HTTP 401 + oRPC エラー code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "setStatus", {
        id: CUSTOMER_TICKET,
        status: "in_progress",
      });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );
});

describe("authz: customer は自分のチケットのみ (HTTP面) @feature-authz", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "customer の list は自分のチケットのみを返し agent 作成チケットが混入しない",
    {
      annotation: {
        type: "description",
        description:
          "agent が作成したチケット(requesterEmail=agent)を1件用意した上で customer が list すると、シードの自分所有3件のみが返り、agent 作成チケットの subject が混入しないことを検証",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const agentSubject = "Agent-only ticket (must not leak to customer)";
      await createAgentTicket(app, agentCookie, agentSubject);

      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "list", {}, customerCookie);
      expect(res.status).toBe(200);
      const list = unwrap(await res.json()) as Array<{
        requesterEmail: string;
        subject: string;
      }>;
      expect(Array.isArray(list)).toBe(true);
      // シードの customer 所有3件のみ。agent が足した1件は含まれない。
      expect(list).toHaveLength(3);
      for (const ticket of list) {
        expect(ticket.requesterEmail).toBe(SEED.customer.email);
      }
      expect(list.some((t) => t.subject === agentSubject)).toBe(false);
    },
  );

  it(
    "agent の list は全件(自分作成 + シード)を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が作成したチケットを1件用意した上で agent が list すると、シード3件 + 自作1件の計4件(フィルタなし)が返ることを検証",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      await createAgentTicket(app, agentCookie, "Agent ticket for full-list check");

      const res = await rpc(app, "list", {}, agentCookie);
      expect(res.status).toBe(200);
      const list = unwrap(await res.json()) as unknown[];
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(4);
    },
  );

  it(
    "customer が他人(agent 作成)のチケットを get すると FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が agent 作成チケット(他人所有)を get すると HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(存在はするが所有者でない)",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const agentTicketId = await createAgentTicket(app, agentCookie, "Agent ticket for get-403");

      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "get", { id: agentTicketId }, customerCookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "customer が他人(agent 作成)のチケットに reply すると FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が agent 作成チケット(他人所有)に reply すると HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(所有確認)",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const agentTicketId = await createAgentTicket(app, agentCookie, "Agent ticket for reply-403");

      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(
        app,
        "reply",
        { ticketId: agentTicketId, body: "can I reply here?" },
        customerCookie,
      );
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "customer の不在チケット get は NOT_FOUND(404)のまま(存在確認 → 所有確認の順)",
    {
      annotation: {
        type: "description",
        description:
          "customer が存在しない id を get すると、認可(FORBIDDEN)ではなく従来どおり HTTP 404 + oRPC code NOT_FOUND になることを検証(判定順は存在確認が先)",
      },
    },
    async () => {
      const app = createApp();
      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "get", { id: MISSING_TICKET }, customerCookie);
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );

  it(
    "customer は自分のチケットを get できる(自分所有の正常経路)",
    {
      annotation: {
        type: "description",
        description:
          "customer が自分所有のシードチケットを get すると HTTP 200 で当該チケット(件名一致)が返ることを検証(認可が自分のチケットを塞がないこと)",
      },
    },
    async () => {
      const app = createApp();
      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "get", { id: CUSTOMER_TICKET }, customerCookie);
      expect(res.status).toBe(200);
      // tickets.get は { ticket, messages } を返す(specs/ticket-detail.md サーバー契約)。
      const detail = unwrap(await res.json()) as {
        ticket: { subject: string; requesterEmail: string };
      };
      expect(detail.ticket.subject).toBe(CUSTOMER_TICKET_SUBJECT);
      expect(detail.ticket.requesterEmail).toBe(SEED.customer.email);
    },
  );
});

describe("authz: setStatus はロール限定 (HTTP面) @feature-authz", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "customer の setStatus は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が自分所有チケットであっても setStatus すると HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(setStatus は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(
        app,
        "setStatus",
        { id: CUSTOMER_TICKET, status: "in_progress" },
        customerCookie,
      );
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の setStatus は従来どおり成功する",
    {
      annotation: {
        type: "description",
        description:
          "agent がシードチケットの status を setStatus で変更すると HTTP 200 で反映後の status(in_progress)が返ることを検証(agent 経路は無変更)",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setStatus",
        { id: CUSTOMER_TICKET, status: "in_progress" },
        agentCookie,
      );
      expect(res.status).toBe(200);
      const updated = unwrap(await res.json()) as { status: string };
      expect(updated.status).toBe("in_progress");
    },
  );
});

describe("authz: draft はエージェント専用 (HTTP面) @feature-authz", () => {
  beforeEach(async () => {
    // draft は mock アダプタの固定文を SSE で返す。ストリーミング遅延を0にして
    // text() が待ちなしで本文を読めるようにする(reply-draft.test.ts の流儀)。
    process.env.MOCK_DELAY_MS = "0";
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "customer の draft は HTTP 403 {error:'forbidden'} で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "customer が POST /api/tickets/draft を叩くと HTTP 403 かつ body {error:'forbidden'} で拒否され、SSE ストリームを開始しないことを検証(draft はエージェント用ツール)",
      },
    },
    async () => {
      const app = createApp();
      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await draft(app, { ticketId: CUSTOMER_TICKET }, customerCookie);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    },
  );

  it(
    "agent の draft は従来どおり mock の固定文を SSE で返す",
    {
      annotation: {
        type: "description",
        description:
          'agent が POST /api/tickets/draft を叩くと text/event-stream で 200 を返し、mock アダプタの固定文("Draft reply for" とチケット件名)がストリーム本文に含まれることを検証(agent 経路は無変更)',
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const res = await draft(app, { ticketId: CUSTOMER_TICKET }, agentCookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("Draft reply for");
      expect(text).toContain(CUSTOMER_TICKET_SUBJECT);
    },
  );
});
