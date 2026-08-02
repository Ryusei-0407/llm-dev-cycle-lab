import { type StreamChunk, toServerSentEventsResponse } from "@tanstack/ai";
import type { Context } from "hono";
import { Hono } from "hono";
import type { User } from "../auth/users.js";
import type { ChatMessage, LLMProvider } from "../llm/provider.js";
import type { CopilotSnapshot, TicketStore } from "./store.js";

// copilot (spec: specs/copilot.md) — a Hono route (not oRPC) that answers
// cross-ticket status questions. The numbers come only from a SQL snapshot
// (store.copilotSnapshot); the LLM never counts. Generation goes through the
// shared LLMProvider (mock/gemini, injected from app.ts) exactly like /api/chat;
// the string deltas it yields are wrapped in the reply-draft AG-UI SSE lifecycle
// so the client's useChat parses this route the same way it parses draft.

// The stats fence (spec): the snapshot JSON is wrapped so the evals judge can
// anchor on it, the MockProvider keys the fixed line on it, and user input can
// never forge or terminate the fence.
const STATS_OPEN = "<<<STATS>>>";
const STATS_CLOSE = "<<<END_STATS>>>";

// Neutralise the fence delimiters in untrusted text (the client's messages), the
// same way evals/judge fences the draft: a message that names <<<STATS>>> /
// <<<END_STATS>>> can't close the snapshot fence early or open a fake one, so the
// composed prompt carries exactly one fence pair (the server's snapshot).
export function neutralizeStats(text: string): string {
  return text.replaceAll(STATS_OPEN, "«STATS»").replaceAll(STATS_CLOSE, "«END_STATS»");
}

// System instruction (spec要点): numbers come only from the snapshot, ticket
// references are always SUP-{number}, answer concisely in Japanese.
export function buildCopilotSystemPrompt(): string {
  return [
    "あなたはサポートデスクのエージェントを補助する Copilot です。",
    "数値は必ず以下のスナップショットの値だけを使い、自分で数え直さないでください。",
    "チケットを参照するときは必ず SUP-{番号} の形式で書いてください。",
    "日本語で簡潔に答えてください。",
  ].join("\n");
}

// The composed conversation the provider streams from: a single user turn
// carrying the system instruction, the fenced snapshot JSON, and the client's
// conversation. Returned as ChatMessage[] so provider.stream sees it and a unit
// test can observe the whole prompt via messages.map(m => m.content).join("\n").
// The snapshot is fenced so the judge (and the mock) can locate it; the client's
// messages are neutralised so they can't forge the fence.
export function buildCopilotPrompt(
  snapshot: CopilotSnapshot,
  messages: ChatMessage[],
): ChatMessage[] {
  const conversation = messages.map((m) => `${m.role}: ${neutralizeStats(m.content)}`).join("\n");
  const content = [
    buildCopilotSystemPrompt(),
    "",
    "以下は現在のチケット状況のスナップショットです。数値はこの値だけを根拠にしてください。",
    STATS_OPEN,
    JSON.stringify(snapshot),
    STATS_CLOSE,
    "",
    "会話:",
    conversation,
  ].join("\n");
  return [{ role: "user", content }];
}

// The client's conversation history. The wire body is { messages: ChatMessage[] }
// (plain { role, content }). Keep only well-formed string-content turns so a
// malformed entry can't smuggle a non-string into the prompt.
function messagesFromBody(body: unknown): ChatMessage[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (typeof content !== "string" || content === "") continue;
    out.push({ role: role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

// Wrap a provider's string deltas in the AG-UI lifecycle (RUN_STARTED →
// TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END → RUN_FINISHED),
// the same wire reply-draft emits so the client's useChat parses this route
// identically. A mid-stream provider error ends the message cleanly rather than
// tearing the SSE response (the client shows its own error state).
async function* toAgui(deltas: AsyncIterable<string>): AsyncIterable<StreamChunk> {
  const runId = "copilot-run";
  const threadId = "copilot-thread";
  const messageId = "copilot-msg";
  yield { type: "RUN_STARTED", threadId, runId } as unknown as StreamChunk;
  yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as unknown as StreamChunk;
  try {
    for await (const delta of deltas) {
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta } as unknown as StreamChunk;
    }
  } finally {
    yield { type: "TEXT_MESSAGE_END", messageId } as unknown as StreamChunk;
    yield { type: "RUN_FINISHED", threadId, runId } as unknown as StreamChunk;
  }
}

// Dependencies injected from app.ts so the route stays free of pool/session
// wiring (parallels draft.ts). provider is the shared LLMProvider (mock/gemini,
// or a fake in unit tests) — the copilot route never selects its own.
export type CopilotDeps = {
  resolveUser: (c: Context) => Promise<User | null>;
  ticketStore: () => TicketStore;
  provider: () => LLMProvider;
};

export function createCopilotRouter(deps: CopilotDeps) {
  const router = new Hono();

  router.post("/chat", async (c) => {
    // Auth first (draft.ts の流儀): no session → 401, never start a stream; a
    // customer is agent-only 403. copilot is an agent-only tool (spec).
    const user = await deps.resolveUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (user.role !== "agent") return c.json({ error: "forbidden" }, 403);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const messages = messagesFromBody(body);

    // Snapshot before generation so the prompt carries the SQL-aggregated
    // numbers (the model never counts).
    const snapshot = await deps.ticketStore().copilotSnapshot();
    const prompt = buildCopilotPrompt(snapshot, messages);
    const stream = toAgui(deps.provider().stream(prompt));

    return toServerSentEventsResponse(stream as AsyncIterable<StreamChunk>);
  });

  return router;
}
