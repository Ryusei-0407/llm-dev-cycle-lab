import pg from "pg";
import { recordDbTime } from "./server-timing.js";

const { Pool } = pg;
export type { Pool } from "pg";

// Connection helper (spec: specs/database.md). One Pool per app/test process,
// built from a connection string (DATABASE_URL). Kept trivial so callers own
// the DATABASE_URL-presence decision (the router turns a missing pool into a
// 500 db_misconfigured rather than connecting to nowhere).
export function createPool(url: string): pg.Pool {
  const pool = new Pool({ connectionString: url });
  // pg emits 'error' on idle clients when the server drops the connection
  // (e.g. E2E teardown stops the DB container). Without a listener this is an
  // unhandled 'error' event that crashes the process; swallow it to a single
  // log line (no object dump — the message is enough to see what happened).
  pool.on("error", (err) => {
    console.error(`[db] idle client error: ${err.message}`);
  });
  // Server-Timing 計装: 全ストアが共有する唯一のチョークポイントで query を
  // 包み、リクエスト中の DB 時間をヘッダへ帰属させる(呼び出し側の変更ゼロ)。
  // このリポジトリは promise 形式しか使わないので、その形だけ包めば足りる。
  type QueryFn = (...args: unknown[]) => Promise<unknown>;
  const originalQuery = pool.query.bind(pool) as QueryFn;
  (pool as unknown as { query: QueryFn }).query = async (...args) => {
    const start = performance.now();
    try {
      return await originalQuery(...args);
    } finally {
      recordDbTime(performance.now() - start);
    }
  };
  return pool;
}
