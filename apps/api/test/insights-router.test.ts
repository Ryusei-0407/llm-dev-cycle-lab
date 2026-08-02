import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";
// insights router surface (spec: specs/insights.md サーバー). Verified on the
// public HTTP面 only (login → sid cookie → /api/rpc/tickets/insights), the same
// contract idiom as triage-router.test.ts / copilot-route.test.ts. These pin the
// authz (agent-only: customer FORBIDDEN, 未認証 UNAUTHORIZED) and the returned
// shape at the wire boundary. The procedure does not exist yet on this branch (RED).

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

describe("tickets.insights はエージェント専用 (HTTP面) @feature-insights", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "insights はセッション無しで 401 UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの tickets.insights が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証(インサイトは agent 専用)",
      },
    },
    async () => {
      const res = await rpc(createApp(), "insights", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "customer の insights は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が tickets.insights を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(インサイト画面は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "insights", {}, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の insights は 200 で仕様どおりの形(集計フィールド一式)を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が tickets.insights を叩くと HTTP 200 で byStatus/byPriority/unassigned/byLabel/resolvedByDay を備えた出力を返し、applySchemaAndSeed 直後は byStatus 各1・unassigned 1・byLabel が固定カタログ5件・resolvedByDay が14要素であることを HTTP 面で検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "insights", {}, cookie);
      expect(res.status).toBe(200);
      const out = unwrap(await res.json()) as {
        byStatus: { open: number; in_progress: number; resolved: number };
        byPriority: { low: number; medium: number; high: number };
        unassigned: number;
        byLabel: Array<{ name: string; color: string; count: number }>;
        resolvedByDay: Array<{ date: string; count: number }>;
      };
      // シード直後の決定論値(applySchemaAndSeed 直後は絶対数を見てよい)。
      expect(out.byStatus).toEqual({ open: 1, in_progress: 1, resolved: 1 });
      expect(out.byPriority).toEqual({ low: 1, medium: 1, high: 1 });
      expect(out.unassigned).toBe(1);
      // 固定カタログ5件を name 昇順で(0件ラベルも含む)。
      expect(out.byLabel.map((l) => l.name)).toEqual(["api", "auth", "billing", "email", "request"]);
      // resolvedByDay は直近14日ぶんの要素。各要素は date + count の形。
      expect(out.resolvedByDay).toHaveLength(14);
      expect(out.resolvedByDay.at(-1)).toEqual(
        expect.objectContaining({
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          count: expect.any(Number),
        }),
      );
    },
  );
});
