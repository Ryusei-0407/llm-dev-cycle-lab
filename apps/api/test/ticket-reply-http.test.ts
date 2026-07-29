import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

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

function rpcReply(app: ReturnType<typeof createApp>, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/rpc/tickets/reply", {
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

const SEED_TICKET = "00000000-0000-7000-8000-000000000001";
const MISSING_TICKET = "00000000-0000-7000-8000-0000000000ff";

describe("tickets.reply guards (HTTP面) @feature-ticket-detail", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "rejects an unauthenticated reply with UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの reply が 401 UNAUTHORIZED で拒否され、匿名メッセージが永続化されないことを検証",
      },
    },
    async () => {
      const app = createApp();
      const res = await rpcReply(app, { ticketId: SEED_TICKET, body: "anonymous?" });
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "returns NOT_FOUND for a reply to a missing ticket",
    {
      annotation: {
        type: "description",
        description: "認証済みでも存在しないチケットへの reply は NOT_FOUND になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const loginRes = await login(app, { email: "agent@example.com", password: "agent-pass" });
      expect(loginRes.status).toBe(200);
      const cookie = `sid=${sidFrom(loginRes)}`;
      const res = await rpcReply(app, { ticketId: MISSING_TICKET, body: "hello?" }, cookie);
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );
});
