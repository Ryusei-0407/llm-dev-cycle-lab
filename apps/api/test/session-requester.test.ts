import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// session-requester (spec: specs/session-requester.md) は tickets.create の
// requesterEmail を「router 側の固定値」ではなく「認証セッションの user.email」
// から導出する。検証は公開 HTTP 面のみ(/api/auth/* でログイン → sid cookie 付き
// /api/rpc/tickets/create)で行い、内部モジュールには触れない。これは
// auth-route.test.ts / tickets-store.test.ts と同じ「契約をテストする」流儀。

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

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
// 後続リクエストに手で載せる(auth-route.test.ts と同じヘルパー)。
function sidFrom(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
}

// oRPC RPCHandler のワイヤ: POST /api/rpc/tickets/create、成功ボディは
// {"json": result}、エラーは serialize された ORPCError({code,status,...})。
// 内部シリアライザの封筒(json ラップ)差異に強くするため、成功値もエラーも
// 封筒の有無を吸収して取り出す。核となる検証は create の HTTP path・status・
// requesterEmail / エラー code(UNAUTHORIZED)。
function rpcCreate(app: ReturnType<typeof createApp>, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/rpc/tickets/create", {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
  });
}

function rpcList(app: ReturnType<typeof createApp>, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/rpc/tickets/list", {
    method: "POST",
    headers,
    body: JSON.stringify({ json: {} }),
  });
}

// oRPC の json 封筒を吸収する: {"json": x} なら x を、素の x ならそのまま返す。
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "json" in (body as Record<string, unknown>)) {
    return (body as { json: unknown }).json;
  }
  return body;
}

async function agentSid(
  app: ReturnType<typeof createApp>,
  seed: { email: string; password: string },
) {
  const res = await login(app, seed);
  expect(res.status).toBe(200);
  const sid = sidFrom(res);
  expect(sid).toBeTruthy();
  return `sid=${sid}`;
}

describe("session-requester (HTTP面) @feature-tickets", () => {
  // create は永続化するので、各テストの前にスキーマ + シードをリセットして
  // テスト間汚染を防ぐ(tickets-store.test.ts と同じ分離方針)。
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  // このレーンはセッション(login)以外の env を触らないが、念のため後始末で
  // テスト間の状態持ち越しを作らない(cookie は各テストローカルに閉じている)。
  afterEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "agent セッションで create すると requesterEmail が agent@example.com になる",
    {
      annotation: {
        type: "description",
        description:
          "agent でログインした cookie 付き create の requesterEmail が固定値ではなくセッション user(agent@example.com)由来になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentSid(app, SEED.agent);

      const res = await rpcCreate(app, { subject: "Agent-created", priority: "medium" }, cookie);
      expect(res.status).toBe(200);
      const created = unwrap(await res.json()) as { requesterEmail: string; subject: string };
      expect(created.subject).toBe("Agent-created");
      expect(created.requesterEmail).toBe(SEED.agent.email);
    },
  );

  it(
    "customer セッションで create すると requesterEmail が customer@example.com になる",
    {
      annotation: {
        type: "description",
        description:
          "customer でログインした cookie 付き create の requesterEmail がセッション user(customer@example.com)由来になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await agentSid(app, SEED.customer);

      const res = await rpcCreate(app, { subject: "Customer-created", priority: "low" }, cookie);
      expect(res.status).toBe(200);
      const created = unwrap(await res.json()) as { requesterEmail: string };
      expect(created.requesterEmail).toBe(SEED.customer.email);
    },
  );

  it(
    "cookie 無しの create は oRPC UNAUTHORIZED(HTTP 401)で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 無しの create が HTTP 401 + oRPC エラー code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpcCreate(createApp(), { subject: "Anon-created", priority: "high" });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "cookie 無しの list は従来どおり成功しシード3件を返す(M2 では create のみ必須)",
    {
      annotation: {
        type: "description",
        description:
          "M2 では list に認可を付けないため、cookie 無しの list が 200 でシード3件を返すことを検証",
      },
    },
    async () => {
      const res = await rpcList(createApp());
      expect(res.status).toBe(200);
      const list = unwrap(await res.json()) as unknown[];
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(3);
    },
  );
});
