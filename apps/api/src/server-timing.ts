import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

// Server-Timing 計測(perf レーンの一次データ)。リクエスト単位のバケツを
// AsyncLocalStorage に置き、db.js の Pool 計装が経過時間を積む — ハンドラ側の
// 配線ゼロで「リクエスト中に走った全クエリ」がそのリクエストに帰属する。
type TimingBucket = { dbMs: number; dbCount: number };

const storage = new AsyncLocalStorage<TimingBucket>();

// Called by the instrumented pg Pool after each query. Outside a request
// (startup, store-level tests) there is no bucket — a silent no-op.
export function recordDbTime(ms: number): void {
  const bucket = storage.getStore();
  if (!bucket) return;
  bucket.dbMs += ms;
  bucket.dbCount += 1;
}

// Emits `Server-Timing: app;dur=…[, db;dur=…]` on API responses. Playwright の
// perf レーン(PW_TRACE=on)はレスポンスヘッダをトレースに記録するため、
// analyze-trace.mjs がこの数値からエンドポイント別のバックエンド内訳
// (総時間 / DB時間 / クエリ数)をランキングできる。
// SSE などストリーミング応答ではヘッダはストリーム開始時に送られるので、
// app;dur は「ストリーム開始までのハンドラ時間」を意味する(全長ではない)。
export const serverTiming: MiddlewareHandler = async (c, next) => {
  // WebSocket upgrade はレスポンスヘッダを拡張できないので素通しする。
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return next();
  const bucket: TimingBucket = { dbMs: 0, dbCount: 0 };
  const start = performance.now();
  await storage.run(bucket, next);
  let value = `app;dur=${(performance.now() - start).toFixed(1)}`;
  if (bucket.dbCount > 0) {
    value += `, db;dur=${bucket.dbMs.toFixed(1)};desc="${bucket.dbCount} queries"`;
  }
  c.header("Server-Timing", value);
};
