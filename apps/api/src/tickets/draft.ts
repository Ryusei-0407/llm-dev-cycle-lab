import { type StreamChunk, toServerSentEventsResponse } from "@tanstack/ai";
import { BaseTextAdapter, chat } from "@tanstack/ai/adapters";
import { geminiText } from "@tanstack/ai-gemini";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { User } from "../auth/users.js";
import type { MessageStore } from "./messages.js";
import type { TicketStore } from "./store.js";

// reply-draft (spec: specs/reply-draft.md) — a Hono route (not oRPC) that reads
// a ticket + its thread, builds a support-agent prompt, and streams an LLM reply
// draft as Server-Sent Events via TanStack AI. The wire format is AG-UI (the
// same shape @tanstack/ai-react's useChat parses on the client).

// The route reads ticketId from the request body. Unit tests POST it at the top
// level ({ ticketId }); TanStack AI's useChat wire wraps extra request data
// under forwardedProps (mirrored under the legacy `data` field), so a real
// browser request carries it nested. Accept both shapes and normalise to a
// single { ticketId } before zod validation — the seam that lets the same route
// serve the deterministic unit contract and the live useChat client.
export const draftInput = z.object({ ticketId: z.string().uuid() });

function ticketIdFromBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.ticketId === "string") return b.ticketId;
  for (const key of ["forwardedProps", "data"] as const) {
    const nested = b[key];
    if (typeof nested === "object" && nested !== null) {
      const id = (nested as Record<string, unknown>).ticketId;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

// Provider selection mirrors the existing /api/chat guard (app.ts): mock is the
// default; gemini requires a key or the whole request is 500 provider_
// misconfigured — never a silent mock fallback, so the nightly smoke lane can't
// go falsely green.
class ProviderMisconfiguredError extends Error {}

// gemini-flash-latest は常に現行世代を指すエイリアス。固定名は新規キーに対して提供
// 終了で 404 になることがある(既存 llm/gemini.ts と同じ既定)。GEMINI_MODELS の
// リテラル union には含まれないため、実行時 env 値としてキャストして渡す。
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

// The fixed line the deterministic mock adapter streams. Unit + E2E pin the
// "Draft reply for" prefix and the echoed subject; the E2E mock (agui-sse.ts)
// reproduces this exact text, so keep the two in lockstep.
export function mockDraft(subject: string): string {
  return `Draft reply for "${subject}": Thanks for reaching out. We are looking into your issue and will follow up shortly.`;
}

// Splits the fixed draft into a few deltas so the mock mirrors real chunked
// streaming (content is the join; order and completeness are what the UI must
// render). Mirrors the E2E helper's draftDeltas.
function draftDeltas(text: string): string[] {
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

// Deterministic mock adapter: emits the AG-UI lifecycle (RUN_STARTED →
// TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END → RUN_FINISHED)
// for the fixed draft line. Same interface a real provider adapter implements
// (geminiText) — switching is an env concern, never a test-code concern. The
// subject is read from the last user message so the fixed line echoes the
// ticket the prompt was built for.
class MockDraftAdapter extends BaseTextAdapter<
  "mock",
  Record<string, never>,
  readonly ["text"],
  never
> {
  readonly name = "mock";

  constructor() {
    super({}, "mock");
  }

  async *chatStream(options: {
    messages: Array<{ role: string; content: unknown }>;
    runId?: string;
    threadId?: string;
  }): AsyncIterable<StreamChunk> {
    const subject = subjectFromMessages(options.messages);
    const runId = options.runId ?? "draft-run";
    const threadId = options.threadId ?? "draft-thread";
    const messageId = "draft-msg";

    yield { type: "RUN_STARTED", threadId, runId } as unknown as StreamChunk;
    yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as unknown as StreamChunk;
    for (const delta of draftDeltas(mockDraft(subject))) {
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta } as unknown as StreamChunk;
    }
    yield { type: "TEXT_MESSAGE_END", messageId } as unknown as StreamChunk;
    yield { type: "RUN_FINISHED", threadId, runId } as unknown as StreamChunk;
  }

  // Unused on the draft path (no structured output), but the abstract base
  // requires it. Never called by chat() here.
  async structuredOutput(): Promise<never> {
    throw new Error("structuredOutput is not supported by the mock draft adapter");
  }
}

// The last user message the prompt assembler emits carries the subject verbatim
// (see buildDraftMessages), so the mock echoes it without re-reading the ticket.
function subjectFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const content = typeof last?.content === "string" ? last.content : "";
  return content.match(/Subject: (.+)/)?.[1]?.trim() ?? content;
}

// A single ticket + its thread, the input the prompt assembler consumes.
export type DraftTicket = {
  subject: string;
  status: string;
  priority: string;
  requesterEmail: string;
};
export type DraftMessage = { authorRole: string; authorEmail: string; body: string };

// System prompt: the support-agent instruction. Kept separate from the
// conversation so the adapter can place it in the provider's system slot.
export function buildDraftSystemPrompt(): string {
  return [
    "You are a support agent for a SaaS help desk.",
    "Write a concise, friendly reply draft to the customer's latest message.",
    "Use the ticket subject and the full thread for context. Do not invent facts.",
  ].join(" ");
}

// Conversation the model sees: one user turn carrying the ticket subject and the
// rendered thread. The "Subject: <subject>" line is load-bearing — the mock
// adapter parses the subject back out of it (subjectFromMessages), and the unit
// test asserts both the subject and the thread bodies appear here.
export function buildDraftMessages(
  ticket: DraftTicket,
  messages: DraftMessage[],
): Array<{ role: "user"; content: string }> {
  const thread = messages.map((m) => `${m.authorRole} (${m.authorEmail}): ${m.body}`).join("\n");
  const content = [
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status} | Priority: ${ticket.priority} | Requester: ${ticket.requesterEmail}`,
    "",
    "Thread:",
    thread,
  ].join("\n");
  return [{ role: "user", content }];
}

function selectDraftStream(
  ticket: DraftTicket,
  messages: DraftMessage[],
): AsyncIterable<StreamChunk> {
  const kind = process.env.LLM_PROVIDER ?? "mock";
  const chatMessages = buildDraftMessages(ticket, messages);
  const systemPrompts = [buildDraftSystemPrompt()];

  if (kind === "gemini") {
    // geminiText auto-detects GEMINI_API_KEY/GOOGLE_API_KEY from env and throws
    // when absent — remap that to the shared misconfigured guard so the route
    // answers 500 provider_misconfigured (never a silent mock fallback).
    let adapter: ReturnType<typeof geminiText>;
    try {
      adapter = geminiText(GEMINI_MODEL as Parameters<typeof geminiText>[0]);
    } catch {
      throw new ProviderMisconfiguredError();
    }
    return chat({ adapter, messages: chatMessages, systemPrompts });
  }

  return chat({ adapter: new MockDraftAdapter(), messages: chatMessages, systemPrompts });
}

// Dependencies the route needs, injected from app.ts so the route stays free of
// the pool/session wiring (parallels how the oRPC context is injected there).
export type DraftDeps = {
  resolveUser: (c: Context) => Promise<User | null>;
  ticketStore: () => TicketStore;
  messageStore: () => MessageStore;
};

export function createDraftRouter(deps: DraftDeps) {
  const router = new Hono();

  router.post("/draft", async (c) => {
    // Auth first: no session → 401, never start a stream (mirrors resolveUser
    // usage in the oRPC context injection; distinct from a bad body).
    const user = await deps.resolveUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = draftInput.safeParse({ ticketId: ticketIdFromBody(body) });
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

    const tickets = await deps.ticketStore().list();
    const ticket = tickets.find((t) => t.id === parsed.data.ticketId);
    if (!ticket) return c.json({ error: "not_found" }, 404);

    const messages = await deps.messageStore().listByTicket(parsed.data.ticketId);

    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = selectDraftStream(ticket, messages);
    } catch (err) {
      if (err instanceof ProviderMisconfiguredError) {
        return c.json({ error: "provider_misconfigured" }, 500);
      }
      throw err;
    }

    // toServerSentEventsResponse returns a Web-standard Response; hand it back to
    // Hono directly (Hono is Web-Response native, per spec's Hono/SSE整合).
    return toServerSentEventsResponse(stream as AsyncIterable<StreamChunk>);
  });

  return router;
}
