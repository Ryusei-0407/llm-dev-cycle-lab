import { createNodeWebSocket } from "@hono/node-ws";
import { GoogleGenAI } from "@google/genai";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createAuthRouter } from "./auth/routes.js";
import type { PasskeyVerifier } from "./auth/passkey.js";
import { createPool } from "./db.js";
import { GeminiProvider } from "./llm/gemini.js";
import { MockProvider } from "./llm/mock.js";
import type { ChatMessage, LLMProvider } from "./llm/provider.js";
import { createRealtimeHub, type RealtimeHub } from "./realtime.js";
import { serverTiming } from "./server-timing.js";
import { createDraftRouter } from "./tickets/draft.js";
import {
  createTicketsRouter,
  getMessageStore,
  getStore,
  isDbConfigured,
} from "./tickets/router.js";

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

// createApp gains an optional { hub } seam (spec: specs/ws-realtime.md): the
// tickets router broadcasts ticket changes through it, and unit tests inject a
// recording hub to observe those broadcasts without opening a socket. Default —
// a fresh in-memory hub — leaves existing callers (index.ts) unaffected.
export type CreateAppOptions = { hub?: RealtimeHub; passkeyVerifier?: PasskeyVerifier };

// Re-exported so the passkey unit tests inject the stub verifier through the
// same createApp seam as { hub } (spec: specs/passkey.md — 検証器は注入可能に).
export type { PasskeyVerifier } from "./auth/passkey.js";

// The node-ws injector must run against the node http server (index.ts), but is
// created here where the app is. Attached to the returned app so index.ts can
// reach it without a second construction path.
export type App = Hono & {
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
};

export function createApp(options: CreateAppOptions = {}): App {
  const app = new Hono();
  const hub = options.hub ?? createRealtimeHub();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // 全 /api/* に Server-Timing(app 合計 + db 内訳)を付与。ルート登録より
  // 先に use しないと包めないため、ここが定位置(server-timing.ts 参照)。
  app.use("/api/*", serverTiming);

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Auth is postgres-backed now (spec: specs/auth-db.md): users + sessions live
  // in the same DB the tickets lane uses (DATABASE_URL). The pool is lazy (no
  // connection until first query), so a missing DATABASE_URL only bites on an
  // actual /api/auth/* request, matching the tickets getters. resolveUser reads
  // the same pool to inject the session user into the oRPC context below.
  const { router: authRouter, resolveUser } = createAuthRouter(
    createPool(process.env.DATABASE_URL ?? ""),
    options.passkeyVerifier,
  );
  app.route("/api/auth", authRouter);

  // /api/ws: realtime fan-out endpoint. Session-required — an unauthenticated
  // upgrade is closed with 1008 (policy violation) so an anonymous client never
  // joins the hub. The socket carries no per-client state: it only receives
  // {type, ticketId} events and re-fetches through its own authorised queries.
  app.get(
    "/api/ws",
    upgradeWebSocket(async (c) => {
      const user = await resolveUser(c);
      return {
        onOpen: (_event, ws) => {
          if (!user) {
            ws.close(1008, "unauthenticated");
            return;
          }
          hub.register(ws);
        },
      };
    }),
  );

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

  const rpcHandler = new RPCHandler({ tickets: createTicketsRouter(hub) });
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

  return Object.assign(app, { injectWebSocket });
}
