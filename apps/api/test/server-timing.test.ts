import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { recordDbTime, serverTiming } from "../src/server-timing.js";

beforeAll(() => {
  process.env.MOCK_DELAY_MS = "0";
});

// Server-Timing middleware の契約(apps/api/src/server-timing.ts)。
// perf レーンはこのヘッダをトレース経由で解析するため、フォーマットが崩れると
// scripts/analyze-trace.mjs の集計が静かに空になる — 形式まで固定する。
describe("serverTiming middleware", () => {
  it("adds an app;dur segment to responses", async () => {
    const app = new Hono();
    app.use("*", serverTiming);
    app.get("/x", (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+(\.\d+)?$/);
  });

  it("aggregates recordDbTime calls into a db segment with a query count", async () => {
    const app = new Hono();
    app.use("*", serverTiming);
    app.get("/x", (c) => {
      recordDbTime(5);
      recordDbTime(7);
      return c.json({ ok: true });
    });

    const res = await app.request("/x");
    expect(res.headers.get("server-timing")).toMatch(
      /^app;dur=\d+(\.\d+)?, db;dur=12(\.\d+)?;desc="2 queries"$/,
    );
  });

  it("omits the db segment when no query ran", async () => {
    const app = new Hono();
    app.use("*", serverTiming);
    app.get("/x", (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.headers.get("server-timing")).not.toContain("db;dur");
  });

  it("is a no-op outside a request scope", () => {
    expect(() => recordDbTime(3)).not.toThrow();
  });

  it("covers the real app: /api/health responds with Server-Timing", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(/app;dur=/);
  });

  it("covers streaming responses: /api/chat SSE carries the header", async () => {
    const res = await createApp().request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("server-timing")).toMatch(/app;dur=/);
  });
});
