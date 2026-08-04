import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// saved-views router surface (spec: specs/saved-views.md サーバー / router観点).
// Verified on the public HTTP面 only (login → sid cookie → /api/rpc/tickets/
// views*), the same contract-testing idiom as set-priority-router.test.ts
// (login/sidFrom/rpc/unwrap helpers). The procedures do not exist yet in this
// branch (RED).
//
// 全手続きは セッション必須 + agent 専用: customer は FORBIDDEN、未認証は
// UNAUTHORIZED。broadcast は行わない(個人設定)ので hub は観測しない。
// viewsCreate は同一ユーザー同名で CONFLICT、viewsDelete は他人/不在 id で
// NOT_FOUND(存在漏えい防止)。

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

const MISSING_ID = "00000000-0000-7000-8000-0000000000ff";

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

describe("saved-views: views* はエージェント専用 (HTTP面) @feature-saved-views", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未認証の viewsList は UNAUTHORIZED(401)",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの viewsList が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(セッション必須)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "viewsList", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "未認証の viewsCreate は UNAUTHORIZED(401)",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの viewsCreate が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(セッション必須)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "viewsCreate", {
        name: "x",
        filters: { status: "open" },
      });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "未認証の viewsDelete は UNAUTHORIZED(401)",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの viewsDelete が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(セッション必須)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "viewsDelete", { id: MISSING_ID });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "customer の viewsList は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が viewsList を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(saved-views は agent 専用・customer には一切見えない)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "viewsList", {}, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "customer の viewsCreate は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が viewsCreate を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "viewsCreate", { name: "x", filters: { status: "open" } }, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "customer の viewsDelete は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が viewsDelete を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "viewsDelete", { id: MISSING_ID }, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の viewsCreate → viewsList は作成したビューを封筒どおり返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が viewsCreate({name, filters}) を叩くと HTTP 200 で { id, name, filters } を返し、続く viewsList に同じビューが1件現れる(自分のビューのみ)ことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const filters = { status: "open", priority: "high" };
      const created = await rpc(app, "viewsCreate", { name: "高優先度の未対応", filters }, cookie);
      expect(created.status).toBe(200);
      const view = unwrap(await created.json()) as {
        id: string;
        name: string;
        filters: unknown;
      };
      expect(view.name).toBe("高優先度の未対応");
      expect(view.filters).toEqual(filters);
      expect(view.id).toBeTruthy();

      const listed = await rpc(app, "viewsList", {}, cookie);
      expect(listed.status).toBe(200);
      const views = unwrap(await listed.json()) as Array<{ id: string; name: string }>;
      expect(views.some((v) => v.id === view.id && v.name === "高優先度の未対応")).toBe(true);
    },
  );

  it(
    "agent の viewsCreate は空白のみの name を BAD_REQUEST(400)で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が空白のみ(trim 後 0 文字)の name を viewsCreate に渡すと入力検証(zod: trim 後 1..32)で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "viewsCreate",
        { name: "   ", filters: { status: "open" } },
        cookie,
      );
      expect(res.status).toBe(400);
    },
  );

  it(
    "agent の viewsCreate は filters が0キーだと BAD_REQUEST(400)で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が空 filters({}) を viewsCreate に渡すと入力検証(zod .refine: 少なくとも1キー必須)で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "viewsCreate", { name: "空フィルタ", filters: {} }, cookie);
      expect(res.status).toBe(400);
    },
  );

  it(
    "agent の viewsCreate は未知キーを含む filters を BAD_REQUEST(400)で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が status/priority/label 以外のキー(assignee)を含む filters を viewsCreate に渡すと strict 検証で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "viewsCreate",
        { name: "未知キー", filters: { status: "open", assignee: "x" } },
        cookie,
      );
      expect(res.status).toBe(400);
    },
  );

  it(
    "agent の viewsCreate は同一ユーザー同名を CONFLICT(409)にする",
    {
      annotation: {
        type: "description",
        description:
          "agent が同名のビューを2回 viewsCreate すると2回目が HTTP 409 + oRPC code CONFLICT になる(UNIQUE 制約を検知して変換)ことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const first = await rpc(
        app,
        "viewsCreate",
        { name: "同名", filters: { status: "open" } },
        cookie,
      );
      expect(first.status).toBe(200);
      const second = await rpc(
        app,
        "viewsCreate",
        { name: "同名", filters: { priority: "low" } },
        cookie,
      );
      expect(second.status).toBe(409);
      const err = unwrap(await second.json()) as { code?: string };
      expect(err.code).toBe("CONFLICT");
    },
  );

  it(
    "agent の viewsDelete は不在 id を NOT_FOUND(404)にする",
    {
      annotation: {
        type: "description",
        description:
          "agent が存在しないビュー id を viewsDelete すると HTTP 404 + oRPC code NOT_FOUND になる(他人のビュー id と同じ応答で存在を漏らさない)ことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "viewsDelete", { id: MISSING_ID }, cookie);
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );
});
