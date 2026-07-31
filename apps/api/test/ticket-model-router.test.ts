import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// ticket-model router surface (spec: specs/ticket-model.md サーバー). Verified on
// the public HTTP面 only (login → sid cookie → /api/rpc/tickets/*), the same
// contract-testing idiom as authz.test.ts (login/sidFrom/rpc/unwrap helpers).
// These pin role scoping, ORPCError codes/messages, and the keyset-pagination
// semantics of listPage. The procedures do not exist yet in this branch (RED).
//
// listPage / setAssignee / setLabels / labels / agents are new; setStatus's
// same-value skip is asserted at the store layer (ticket-model-store.test.ts).

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

const CUSTOMER_TICKET = "00000000-0000-7000-8000-000000000001"; // customer 所有・未割り当て・auth
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

describe("ticket-model: setAssignee はエージェント専用 (HTTP面) @feature-ticket-model", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "customer の setAssignee は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が setAssignee を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(setAssignee は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(
        app,
        "setAssignee",
        { id: CUSTOMER_TICKET, assigneeEmail: SEED.agent.email },
        cookie,
      );
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の setAssignee は成功し Ticket を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が未割り当てチケットに setAssignee すると HTTP 200 で assigneeEmail 反映後の Ticket が返ることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setAssignee",
        { id: CUSTOMER_TICKET, assigneeEmail: SEED.agent.email },
        cookie,
      );
      expect(res.status).toBe(200);
      const ticket = unwrap(await res.json()) as { assigneeEmail: string };
      expect(ticket.assigneeEmail).toBe(SEED.agent.email);
    },
  );

  it(
    "agent の setAssignee は agent でないメールを BAD_REQUEST 'not an agent' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が role=customer のメールを setAssignee に渡すと HTTP 400 + oRPC code BAD_REQUEST、message 'not an agent' で拒否されることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setAssignee",
        { id: CUSTOMER_TICKET, assigneeEmail: SEED.customer.email },
        cookie,
      );
      expect(res.status).toBe(400);
      const err = unwrap(await res.json()) as { code?: string; message?: string };
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toBe("not an agent");
    },
  );

  it(
    "agent の setAssignee は不在チケットに NOT_FOUND(404)",
    {
      annotation: {
        type: "description",
        description:
          "agent が存在しない id に setAssignee すると HTTP 404 + oRPC code NOT_FOUND になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setAssignee",
        { id: MISSING_TICKET, assigneeEmail: SEED.agent.email },
        cookie,
      );
      expect(res.status).toBe(404);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("NOT_FOUND");
    },
  );
});

describe("ticket-model: setLabels はエージェント専用 (HTTP面) @feature-ticket-model", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "customer の setLabels は FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が setLabels を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(setLabels は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "setLabels", { id: CUSTOMER_TICKET, labels: ["billing"] }, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );

  it(
    "agent の setLabels は成功し name 昇順の labels を持つ Ticket を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が setLabels で [billing, api] を全置換すると HTTP 200 で labels が name 昇順(api, billing)の Ticket が返ることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setLabels",
        { id: CUSTOMER_TICKET, labels: ["billing", "api"] },
        cookie,
      );
      expect(res.status).toBe(200);
      const ticket = unwrap(await res.json()) as { labels: Array<{ name: string }> };
      expect(ticket.labels.map((l) => l.name)).toEqual(["api", "billing"]);
    },
  );

  it(
    "agent の setLabels はカタログ外 name を BAD_REQUEST 'unknown label' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "agent が labels カタログにない name を setLabels に渡すと HTTP 400 + oRPC code BAD_REQUEST、message 'unknown label' で拒否されることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(
        app,
        "setLabels",
        { id: CUSTOMER_TICKET, labels: ["nonexistent"] },
        cookie,
      );
      expect(res.status).toBe(400);
      const err = unwrap(await res.json()) as { code?: string; message?: string };
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toBe("unknown label");
    },
  );
});

describe("ticket-model: labels / agents カタログ手続き (HTTP面) @feature-ticket-model", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "labels はセッションがあれば customer にも name 昇順の Label[] を返す",
    {
      annotation: {
        type: "description",
        description:
          "tickets.labels がロール不問(customer セッションでも)HTTP 200 で name 昇順の Label[](固定5種)を返すことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "labels", {}, cookie);
      expect(res.status).toBe(200);
      const labels = unwrap(await res.json()) as Array<{ name: string; color: string }>;
      const names = labels.map((l) => l.name);
      expect(names).toEqual([...names].sort());
      expect(names).toEqual(["api", "auth", "billing", "email", "request"]);
      for (const l of labels) expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    },
  );

  it(
    "labels はセッション無しで 401 UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの tickets.labels が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "labels", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "agents はエージェント専用で email 昇順の { email, name }[] を返す",
    {
      annotation: {
        type: "description",
        description:
          "agent が tickets.agents を叩くと HTTP 200 で email 昇順の { email, name }[] を返し、各要素が agent メールを含むことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "agents", {}, cookie);
      expect(res.status).toBe(200);
      const agents = unwrap(await res.json()) as Array<{ email: string; name: string }>;
      expect(agents.length).toBeGreaterThan(0);
      const emails = agents.map((a) => a.email);
      expect(emails).toEqual([...emails].sort());
      expect(emails).toContain(SEED.agent.email);
      for (const a of agents) expect(typeof a.name).toBe("string");
    },
  );

  it(
    "agents は customer に FORBIDDEN(403)",
    {
      annotation: {
        type: "description",
        description:
          "customer が tickets.agents を叩くと HTTP 403 + oRPC code FORBIDDEN で拒否されることを検証(担当者候補は agent 専用)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "agents", {}, cookie);
      expect(res.status).toBe(403);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("FORBIDDEN");
    },
  );
});

// listPage: keyset pagination over the same ordering/role scope as list
// (created_at DESC, id DESC). Assertions avoid absolute seed counts where the
// shared DB could drift; they walk pages relatively and check the terminal
// nextCursor. To make "残件ちょうど limit 件で null" deterministic against a
// possibly-mutated shared seed, we snapshot the full order via list() first and
// derive limits from it, rather than hardcoding 3.
describe("ticket-model: listPage キーセットページネーション (HTTP面) @feature-ticket-model", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  async function listAll(app: ReturnType<typeof createApp>, cookie: string): Promise<string[]> {
    const res = await rpc(app, "list", {}, cookie);
    expect(res.status).toBe(200);
    const list = unwrap(await res.json()) as Array<{ id: string }>;
    return list.map((t) => t.id);
  }

  it(
    "listPage はセッション無しで 401 UNAUTHORIZED",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しの tickets.listPage が HTTP 401 + oRPC code UNAUTHORIZED で拒否されることを検証",
      },
    },
    async () => {
      const res = await rpc(createApp(), "listPage", {});
      expect(res.status).toBe(401);
      const err = unwrap(await res.json()) as { code?: string };
      expect(err.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "listPage の並びは list と同一(created_at DESC, id DESC)",
    {
      annotation: {
        type: "description",
        description:
          "十分大きい limit で取得した listPage の items の id 列が、list の id 列と完全一致することを検証(並び・ロールスコープが list と同一)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const ordered = await listAll(app, cookie);

      const res = await rpc(app, "listPage", { limit: 100 }, cookie);
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page.items.map((t) => t.id)).toEqual(ordered);
    },
  );

  it(
    "listPage はカーソルで次ページを重複なく連結して返す",
    {
      annotation: {
        type: "description",
        description:
          "limit=1 で先頭ページ→nextCursor→2ページ目…と辿ると、各ページの id を順に連結した列が list の全 id 列と一致し、重複や欠落が無いことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const ordered = await listAll(app, cookie);

      const collected: string[] = [];
      let cursor: string | null = null;
      // Guard against an infinite loop if nextCursor never terminates.
      for (let guard = 0; guard <= ordered.length + 1; guard++) {
        const input: { limit: number; cursor?: string } = { limit: 1 };
        if (cursor) input.cursor = cursor;
        const res = await rpc(app, "listPage", input, cookie);
        expect(res.status).toBe(200);
        const pageResult = unwrap(await res.json()) as {
          items: Array<{ id: string }>;
          nextCursor: string | null;
        };
        for (const t of pageResult.items) collected.push(t.id);
        cursor = pageResult.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBe(null);
      expect(collected).toEqual(ordered);
    },
  );

  it(
    "残件がちょうど limit 件のとき nextCursor は null(先読み判定)",
    {
      annotation: {
        type: "description",
        description:
          "全件数 N を list から求め、limit=N で1ページ取得すると全件が返り、残件がちょうど limit でも nextCursor が null になる(空の追加ページを返さない)ことを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const ordered = await listAll(app, cookie);

      const res = await rpc(app, "listPage", { limit: ordered.length }, cookie);
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page.items.map((t) => t.id)).toEqual(ordered);
      expect(page.nextCursor).toBe(null);
    },
  );

  it(
    "listPage は不正カーソルを BAD_REQUEST 'invalid cursor' で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "デコード不能なトークンを cursor に渡した listPage が HTTP 400 + oRPC code BAD_REQUEST、message 'invalid cursor' で拒否されることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "listPage", { cursor: "!!!not-a-valid-cursor!!!" }, cookie);
      expect(res.status).toBe(400);
      const err = unwrap(await res.json()) as { code?: string; message?: string };
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toBe("invalid cursor");
    },
  );

  it(
    "listPage は base64url は妥当だが id が uuid でない偽造カーソルも BAD_REQUEST で拒否する",
    {
      annotation: {
        type: "description",
        description:
          "敵対的レビューの反例の固定: 正当な base64url・正当な ISO 日付・非 uuid の id を持つトークンが SQL の ::uuid キャストへ到達して 500 になる経路を塞ぎ、400 'invalid cursor' で拒否されることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const forged = Buffer.from("2026-01-01T00:00:00.000Z|not-a-uuid", "utf8").toString(
        "base64url",
      );
      const res = await rpc(app, "listPage", { cursor: forged }, cookie);
      expect(res.status).toBe(400);
      const err = unwrap(await res.json()) as { code?: string; message?: string };
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toBe("invalid cursor");
    },
  );

  it(
    "listPage は limit 範囲外(0)を zod で 400 拒否する",
    {
      annotation: {
        type: "description",
        description:
          "limit=0(1..100 の範囲外)を listPage に渡すと入力検証(zod)で HTTP 400 になることを検証",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.agent);
      const res = await rpc(app, "listPage", { limit: 0 }, cookie);
      expect(res.status).toBe(400);
    },
  );

  it(
    "customer の listPage は自分のチケットのみを返す(ロールスコープ)",
    {
      annotation: {
        type: "description",
        description:
          "customer が listPage を叩くと、返る items がすべて自分所有(requesterEmail=customer)であることを検証(スコープが list と同一)",
      },
    },
    async () => {
      const app = createApp();
      const cookie = await cookieFor(app, SEED.customer);
      const res = await rpc(app, "listPage", { limit: 100 }, cookie);
      expect(res.status).toBe(200);
      const page = unwrap(await res.json()) as {
        items: Array<{ requesterEmail: string }>;
      };
      for (const t of page.items) {
        expect(t.requesterEmail).toBe(SEED.customer.email);
      }
    },
  );
});
