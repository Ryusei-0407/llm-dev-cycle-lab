import pg from "pg";

const { Pool } = pg;
export type { Pool } from "pg";

// Connection helper (spec: specs/database.md). One Pool per app/test process,
// built from a connection string (DATABASE_URL). Kept trivial so callers own
// the DATABASE_URL-presence decision (the router turns a missing pool into a
// 500 db_misconfigured rather than connecting to nowhere).
export function createPool(url: string): pg.Pool {
  return new Pool({ connectionString: url });
}
