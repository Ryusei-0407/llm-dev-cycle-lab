import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";
// triage router surface (spec: specs/triage.md サーバー). Verified on the public
// HTTP面 only (login → sid cookie → /api/rpc/tickets/*), the same contract idiom
// as ticket-model-router.test.ts / authz.test.ts. These pin the two triage
// additions at the wire boundary: inboxCount is agent-only (customer FORBIDDEN),
// and listPage's new filters actually narrow results over HTTP. The procedures /
// input fields do not exist yet in this branch (RED).

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

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

describe("triage: inboxCount はエージェント専用 (HTTP面) @feature-triage", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "inboxCount はセッション無しで 401 UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの tickets.inboxCount が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "inboxCount", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "customer の inboxCount は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が tickets.inboxCount を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(受信トレイ件数は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "inboxCount", {}, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の inboxCount はシード直後 number 1 を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が tickets.inboxCount を叩くと HTTP 200 で number を返し、applySchemaAndSeed 直後は未割り当てかつ非 resolved のシード1件ぶんの 1 であることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "inboxCount", {}, cookie);
      expect(res.status).toBe(200);
      const count = unwrap(await res.json());
      expect(count).toBe(1);
    },
  );
});

describe("triage: listPage フィルタが HTTP面で機能する @feature-triage", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "listPage の priority=high は high のチケットだけを返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が listPage を priority=high で叩くと、返る items がすべて priority=high(シードでは Cannot login のみ)で、medium/low(Billing/Feature)が除外されることを検証(サーバサイドフィルタが HTTP 面で効く)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "listPage", { limit: 100, priority: "high" }, cookie);
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as {
        items: Array<{ subject: string; priority: string }>;
      };
      expect(page.items.map((t) => t.subject)).toContain("Cannot login to dashboard");
      expect(page.items.map((t) => t.subject)).not.toContain("Billing question");
      for (const t of page.items) {
        expect(t.priority).toBe("high");
      }
    },
  );

  it(
    "listPage の unassigned+unresolved は受信トレイの中身に一致する",
    {
      annotation: {
        type: "description",
        description:
          "agent が listPage を unassigned=true・unresolved=true で叩くと、返る items に未割り当てかつ非 resolved のシード(Cannot login)が含まれ、割り当て済み(Billing)・resolved(Feature)が除外されることを検証(inbox の取得条件が HTTP 面で効く)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "listPage",
        { limit: 100, unassigned: true, unresolved: true },
        cookie,
      );
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as { items: Array<{ subject: string }> };
      const subjects = page.items.map((t) => t.subject);
      expect(subjects).toContain("Cannot login to dashboard");
      expect(subjects).not.toContain("Billing question");
      expect(subjects).not.toContain("Feature request: dark mode");
    },
  );

  it(
    "customer の listPage は自分所有のみ(agent 所有チケットが混入しない)",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反例の固定: router が customer スコープを listPage に渡し忘れる改竄が全テストを通過していた(クロスオーナー漏洩)。agent 所有チケットを作った上で customer の listPage に混入しないことを HTTP 面で検証",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const secret = "Agent-owned secret (scope pin)";
      const created = await rpc(app, "create", { subject: secret, priority: "low" }, agentCookie);
      expect(created.status).toBe(200);

      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "listPage", { limit: 100 }, customerCookie);
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as {
        items: Array<{ subject: string; requesterEmail: string }>;
      };
      const subjects = page.items.map((t) => t.subject);
      expect(subjects).toContain("Cannot login to dashboard");
      expect(subjects).not.toContain(secret);
      for (const t of page.items) {
        expect(t.requesterEmail).toBe(SEED.customer.email);
      }
    },
  );
});
