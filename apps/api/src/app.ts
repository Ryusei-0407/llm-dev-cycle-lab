import { GoogleGenAI } from "@google/genai";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createAuthRouter } from "./auth/routes.js";
import { createPool } from "./db.js";
import { GeminiProvider } from "./llm/gemini.js";
import { MockProvider } from "./llm/mock.js";
import type { ChatMessage, LLMProvider } from "./llm/provider.js";
import { createDraftRouter } from "./tickets/draft.js";
import { appRouter, getMessageStore, getStore, isDbConfigured } from "./tickets/router.js";

// Thrown when LLM_PROVIDER selects a real provider whose required config is
// missing. Surfaced as 500 provider_misconfigured — never a silent mock
// fallback, so the nightly smoke lane can't go falsely green.
class ProviderMisconfiguredError extends Error {}

function getProvider(): LLMProvider {
  const kind = process.env.LLM_PROVIDER ?? "mock";
  if (kind === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new ProviderMisconfiguredError();
    return new GeminiProvider(new GoogleGenAI({ apiKey }));
  }
  return new MockProvider();
}

export function createApp() {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Auth is postgres-backed now (spec: specs/auth-db.md): users + sessions live
  // in the same DB the tickets lane uses (DATABASE_URL). The pool is lazy (no
  // connection until first query), so a missing DATABASE_URL only bites on an
  // actual /api/auth/* request, matching the tickets getters. resolveUser reads
  // the same pool to inject the session user into the oRPC context below.
  const { router: authRouter, resolveUser } = createAuthRouter(
    createPool(process.env.DATABASE_URL ?? ""),
  );
  app.route("/api/auth", authRouter);

  // DB config guard: tickets is now postgres-backed, so a missing DATABASE_URL
  // is a 500 db_misconfigured (same shape as the LLM provider_misconfigured
  // guard) rather than a silent failure. Runs before the oRPC handler so no
  // procedure attempts to connect to nowhere.
  app.use("/api/rpc/*", async (c, next) => {
    if (!isDbConfigured()) {
      return c.json({ error: "db_misconfigured" }, 500);
    }
    await next();
  });

  const rpcHandler = new RPCHandler(appRouter);
  app.use("/api/rpc/*", async (c, next) => {
    // Inject the resolved session user so procedures (tickets.create/reply) can
    // author from context instead of trusting client input. Null when
    // unauthenticated.
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context: { user: await resolveUser(c) },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  // reply-draft (spec: specs/reply-draft.md): POST /api/tickets/draft streams an
  // LLM reply draft as SSE. Same DB guard as /api/rpc/* — a missing DATABASE_URL
  // is 500 db_misconfigured before any store query, never a silent failure.
  app.use("/api/tickets/*", async (c, next) => {
    if (!isDbConfigured()) {
      return c.json({ error: "db_misconfigured" }, 500);
    }
    await next();
  });
  app.route(
    "/api/tickets",
    createDraftRouter({ resolveUser, ticketStore: getStore, messageStore: getMessageStore }),
  );

  app.post("/api/chat", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const messages = (body as { messages?: unknown })?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages required" }, 400);
    }
    const last = messages[messages.length - 1] as ChatMessage | undefined;
    if (last?.content === "__error__") {
      return c.json({ error: "provider failure" }, 500);
    }

    let provider: LLMProvider;
    try {
      provider = getProvider();
    } catch (err) {
      if (err instanceof ProviderMisconfiguredError) {
        return c.json({ error: "provider_misconfigured" }, 500);
      }
      throw err;
    }
    return streamSSE(c, async (stream) => {
      try {
        for await (const delta of provider.stream(messages as ChatMessage[])) {
          await stream.writeSSE({ data: JSON.stringify({ delta }) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch {
        await stream.writeSSE({ data: JSON.stringify({ error: "stream_failed" }) });
      }
    });
  });

  return app;
}
