import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

// E2E worker-per-schema isolation (opt-in: E2E_ISOLATE=1, set only by the E2E
// launcher). Playwright workers share one database and one api process, so
// their writes interleave — the ticket lists every worker sees include every
// other worker's tickets, which turns purely geometric properties (virtual-list
// windows, board column heights) into cross-worker interference. This module
// gives each worker its own PostgreSQL schema for the ticket domain while auth
// stays shared:
//
//   - The request names its worker (cookie from browser contexts / header from
//     Playwright request fixtures); a Hono middleware parks the schema name in
//     this AsyncLocalStorage for the request's async lifetime (SSE included).
//   - createIsolatedPool routes query()/connect() to a per-schema pg.Pool whose
//     search_path is `<schema>,public` — fixed as a connection startup option,
//     so it applies to every pooled connection and never races across requests.
//   - First use of a schema provisions it: schema.sql + seed.sql run with
//     search_path pinned to the worker schema alone, then the auth tables
//     (users/sessions/passkeys) are dropped from it so auth queries fall
//     through to the shared public copies. auth.setup logs in once per run and
//     that session must resolve in every worker.
//
// Production and unit tests never set the flag: createPool (db.ts) returns a
// plain pool and this storage stays empty.

export const workerSchemaStorage = new AsyncLocalStorage<string>();

export function isolationEnabled(): boolean {
  return process.env.E2E_ISOLATE === "1";
}

// "" = the default (public) schema — requests that name no worker.
export function currentSchema(): string {
  return workerSchemaStorage.getStore() ?? "";
}

// Schema name from a client-supplied worker id. Digits only: the value is
// interpolated into DDL, so anything else must never become an identifier.
export function schemaForWorker(workerId: string): string | undefined {
  return /^\d{1,3}$/.test(workerId) ? `e2e_w${workerId}` : undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = (file: string) => fs.readFileSync(path.resolve(here, "..", "db", file), "utf8");

// Process-global: createPool is called once per store (auth / tickets /
// messages), so several facades coexist. Provisioning DROPs and recreates the
// worker schema — deduped per facade it would run once per facade and wipe
// live data mid-test. One promise per schema per process.
const provisioned = new Map<string, Promise<void>>();

export function createIsolatedPool(url: string, onError: (err: Error) => void): pg.Pool {
  const pools = new Map<string, pg.Pool>();

  const rawPool = (schema: string): pg.Pool => {
    let pool = pools.get(schema);
    if (!pool) {
      pool = new Pool({
        connectionString: url,
        ...(schema ? { options: `-c search_path=${schema},public` } : {}),
      });
      pool.on("error", onError);
      pools.set(schema, pool);
    }
    return pool;
  };

  async function provision(schema: string): Promise<void> {
    const admin = rawPool("");
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    // DDL runs on a dedicated client with search_path pinned to the worker
    // schema ALONE: schema.sql opens with unqualified DROP TABLE IF EXISTS,
    // which with a public fallback in the path would drop the shared tables.
    const client = await admin.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(ddl("schema.sql"));
      await client.query(ddl("seed.sql"));
      await client.query("DROP TABLE passkeys, sessions, users CASCADE");
    } finally {
      // The client returns to the shared admin pool — restore its search_path.
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
  }

  const ensureProvisioned = (schema: string): Promise<void> => {
    let ready = provisioned.get(schema);
    if (!ready) {
      ready = provision(schema);
      provisioned.set(schema, ready);
    }
    return ready;
  };

  const facade = {
    async query(...args: unknown[]) {
      const schema = currentSchema();
      if (schema) await ensureProvisioned(schema);
      const query = rawPool(schema).query.bind(rawPool(schema)) as (
        ...a: unknown[]
      ) => Promise<unknown>;
      return query(...args);
    },
    async connect() {
      const schema = currentSchema();
      if (schema) await ensureProvisioned(schema);
      return rawPool(schema).connect();
    },
    // Errors are logged per underlying pool (attached at creation above).
    on() {
      return facade;
    },
    async end() {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
    },
  };
  return facade as unknown as pg.Pool;
}
