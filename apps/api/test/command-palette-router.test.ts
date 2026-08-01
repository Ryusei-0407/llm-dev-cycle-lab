import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";
// command-palette adds tickets.search at the oRPC surface (spec:
// specs/command-palette.md サーバー). Verified on the public HTTP面 only
// (login → sid cookie → /api/rpc/tickets/search), the same contract idiom as
// triage-router.test.ts / ticket-model-router.test.ts. Pins the two authz facts
// the spec fixes: session required (401), and customer scope (agent 所有 must not
// leak into a customer search — triage-router の scope pin と同じ流儀)。The
// procedure does not exist yet in this branch (RED)。
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

describe("command-palette: tickets.search (HTTP面) @feature-command-palette", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "search はセッション無しで 401 UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの tickets.search が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(検索はセッション必須)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "search", { q: "billing" });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "agent の search は subject 部分一致でシード行を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が tickets.search を q='Billing' で叩くと HTTP 200 で Ticket[] を返し、subject に Billing question が含まれることを検証(検索が HTTP 面で機能する)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "search", { q: "Billing" }, cookie);
      expect(res.status).toBe(200);
      const rows = unwrap(await res.json()) as Array<{ subject: string }>;
      expect(rows.map((t) => t.subject)).toContain("Billing question");
    },
  );

  it(
    "customer の search に agent 所有チケットが混入しない(スコープ)",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反例の固定: router が search に customer スコープを渡し忘れる改竄がクロスオーナー漏洩を許す。agent 所有チケットを作った上で、同じ subject 語で customer が search してもその行が返らず、customer 所有の同語シードは返ることを HTTP 面で検証",
      },
    },
    async () => {
      const app = createApp();
      const agentCookie = await cookieFor(app, SEED.agent);
      const secret = "Billing secret (agent-owned scope pin)";
      const created = await rpc(app, "create", { subject: secret, priority: "low" }, agentCookie);
      expect(created.status).toBe(200);

      const customerCookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "search", { q: "billing" }, customerCookie);
      expect(res.status).toBe(200);
      const rows = unwrap(await res.json()) as Array<{ subject: string }>;
      const subjects = rows.map((t) => t.subject);
      // customer 所有の同語シードは出る(検索自体は効いている)。
      expect(subjects).toContain("Billing question");
      // agent 所有は scope で除外される。これが無いと scope 未実装でも通る。
      expect(subjects).not.toContain(secret);
    },
  );
});
