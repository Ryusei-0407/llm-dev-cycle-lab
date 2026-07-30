import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
// auth is being migrated from in-memory to pg (spec: specs/auth-db.md). These
// are the public shapes the spec fixes; the modules take async + pool contracts
// that do not exist yet on this branch (RED). users.ts exposes
// verifyCredentials(pool, …)/userById(pool, …); session.ts exposes
// createDbSessionStore(pool). createPool is the shared connection helper
// (apps/api/src/db.ts), same as the tickets lane.
import { createPool } from "../src/db.js";
import { createDbSessionStore } from "../src/auth/session.js";
import { userById, verifyCredentials } from "../src/auth/users.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed
// seeds — the idempotent reset the DB lanes lean on for per-test isolation.
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// Connection comes from the vitest globalSetup (apps/api/test/global-setup.ts),
// which provisions/resets a temp DB and exports DATABASE_URL. Never hardcode a
// connection string here — POLICY.md §共通規約: 接続情報をテストコードに書かない.
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/auth-db.md)",
    );
  }
  return url;
}

// The deterministic user seed (spec: specs/auth-db.md). Passwords match the
// existing HTTP auth tests (auth-route.test.ts). The seed's password_hash is a
// scrypt hash the implementation computes; these plaintexts are what
// verifyCredentials must accept. ids are the fixed v7 literals from the spec.
const SEED = {
  agent: {
    id: "00000000-0000-7000-8000-0000000000a1",
    email: "agent@example.com",
    password: "agent-pass",
    role: "agent",
    name: "Aki Agent",
  },
  customer: {
    id: "00000000-0000-7000-8000-0000000000a2",
    email: "customer@example.com",
    password: "customer-pass",
    role: "customer",
    name: "Chika Customer",
  },
} as const;

describe("verifyCredentials (postgres) @feature-auth", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(databaseUrl());
  });

  afterAll(async () => {
    await pool.end();
  });

  // Per-test isolation: reset schema + seed before every case so a session
  // mutation elsewhere cannot leak into these credential assertions.
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "正しい資格情報でシードユーザーの公開形を返す",
    {
      annotation: {
        type: "description",
        description:
          "正しい email/password で verifyCredentials がシードユーザーの公開形(id/email/role/name)を返し、password_hash を含まないことを検証",
      },
    },
    async () => {
      const user = await verifyCredentials(pool, SEED.agent.email, SEED.agent.password);
      expect(user).toMatchObject({
        id: SEED.agent.id,
        email: SEED.agent.email,
        role: SEED.agent.role,
        name: SEED.agent.name,
      });
      // password_hash must never surface on the public User shape.
      expect(user).not.toHaveProperty("password_hash");
      expect(user).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(user)).not.toContain(SEED.agent.password);
    },
  );

  it(
    "customer シードも正しい資格情報で認証できる",
    {
      annotation: {
        type: "description",
        description:
          "customer シードユーザーも正しい資格情報で verifyCredentials が公開形を返すことを検証(役割別シードの網羅)",
      },
    },
    async () => {
      const user = await verifyCredentials(pool, SEED.customer.email, SEED.customer.password);
      expect(user).toMatchObject({
        id: SEED.customer.id,
        email: SEED.customer.email,
        role: SEED.customer.role,
        name: SEED.customer.name,
      });
    },
  );

  it(
    "誤ったパスワードでは null を返す",
    {
      annotation: {
        type: "description",
        description:
          "既知ユーザーの email に誤ったパスワードを与えると verifyCredentials が null を返すことを検証",
      },
    },
    async () => {
      const user = await verifyCredentials(pool, SEED.agent.email, "wrong-pass");
      expect(user).toBeNull();
    },
  );

  it(
    "未知のユーザーでは null を返す",
    {
      annotation: {
        type: "description",
        description:
          "シードに存在しない email を与えると verifyCredentials が null を返すことを検証",
      },
    },
    async () => {
      const user = await verifyCredentials(pool, "nobody@example.com", "whatever");
      expect(user).toBeNull();
    },
  );
});

describe("userById (postgres) @feature-auth", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(databaseUrl());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "既知の id で公開形のユーザーを返す",
    {
      annotation: {
        type: "description",
        description:
          "既知の user id で userById がシードユーザーの公開形を返し、password_hash を含まないことを検証",
      },
    },
    async () => {
      const user = await userById(pool, SEED.agent.id);
      expect(user).toMatchObject({
        id: SEED.agent.id,
        email: SEED.agent.email,
        role: SEED.agent.role,
        name: SEED.agent.name,
      });
      expect(user).not.toHaveProperty("password_hash");
      expect(user).not.toHaveProperty("passwordHash");
    },
  );

  it(
    "未知の id では null を返す",
    {
      annotation: {
        type: "description",
        description: "シードに存在しない user id では userById が null を返すことを検証",
      },
    },
    async () => {
      const user = await userById(pool, "00000000-0000-7000-8000-0000000000ff");
      expect(user).toBeNull();
    },
  );
});

describe("createDbSessionStore (postgres) @feature-auth", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(databaseUrl());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "create → verify が発行ユーザーの id を解決する",
    {
      annotation: {
        type: "description",
        description:
          "createDbSessionStore で作成した sid を同一 store で verify すると、発行時の userId を解決することを検証",
      },
    },
    async () => {
      const store = createDbSessionStore(pool);
      const sid = await store.create(SEED.agent.id);
      expect(typeof sid).toBe("string");
      expect(sid).toBeTruthy();
      expect(await store.verify(sid)).toBe(SEED.agent.id);
    },
  );

  it(
    "destroy 後は verify が null を返す(セッション失効)",
    {
      annotation: {
        type: "description",
        description:
          "createDbSessionStore で作成した sid を destroy した後、verify が null を返しセッションが失効することを検証",
      },
    },
    async () => {
      const store = createDbSessionStore(pool);
      const sid = await store.create(SEED.customer.id);
      expect(await store.verify(sid)).toBe(SEED.customer.id);
      await store.destroy(sid);
      expect(await store.verify(sid)).toBeNull();
    },
  );

  it(
    "未知の sid では verify が null を返す",
    {
      annotation: {
        type: "description",
        description:
          "作成していない未知の sid を verify すると null を返すことを検証(不正セッションの拒否)",
      },
    },
    async () => {
      const store = createDbSessionStore(pool);
      expect(await store.verify("00000000-0000-4000-8000-0000000000ff")).toBeNull();
    },
  );

  it(
    "別 store インスタンスからも sid を verify できる(DB 永続の証明)",
    {
      annotation: {
        type: "description",
        description:
          "ある store で作成した sid を、別インスタンスの store で verify できることを検証。セッションが in-memory ではなく DB に永続していることの証明",
      },
    },
    async () => {
      const writer = createDbSessionStore(pool);
      const sid = await writer.create(SEED.agent.id);

      // A distinct store instance sharing only the DB — an in-memory Map would
      // not carry the session across instances; DB persistence does.
      const reader = createDbSessionStore(pool);
      expect(await reader.verify(sid)).toBe(SEED.agent.id);
    },
  );

  it(
    "別 store インスタンスの destroy も反映される(DB 永続の証明)",
    {
      annotation: {
        type: "description",
        description:
          "ある store で作成した sid を別インスタンスの store で destroy すると、元の store からも verify が null になることを検証。破棄が DB を経由して共有されることの証明",
      },
    },
    async () => {
      const writer = createDbSessionStore(pool);
      const sid = await writer.create(SEED.customer.id);

      const other = createDbSessionStore(pool);
      await other.destroy(sid);

      expect(await writer.verify(sid)).toBeNull();
    },
  );

  it(
    "create は毎回異なる sid を割り当てる",
    {
      annotation: {
        type: "description",
        description:
          "連続した create が互いに異なる sid を発行することを検証(セッションIDの一意性)",
      },
    },
    async () => {
      const store = createDbSessionStore(pool);
      const a = await store.create(SEED.agent.id);
      const b = await store.create(SEED.agent.id);
      expect(a).not.toBe(b);
    },
  );
});
