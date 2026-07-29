import { GoogleGenAI } from "@google/genai";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createAuthRouter } from "./auth/routes.js";
import { GeminiProvider } from "./llm/gemini.js";
import { MockProvider } from "./llm/mock.js";
import type { ChatMessage, LLMProvider } from "./llm/provider.js";
import { appRouter, isDbConfigured } from "./tickets/router.js";

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

  // Session store lives for the life of this app instance (in-memory), so all
  // /api/auth/* requests against one createApp() share it.
  const { router: authRouter, resolveUser } = createAuthRouter();
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
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context: { user: resolveUser(c) },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

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
