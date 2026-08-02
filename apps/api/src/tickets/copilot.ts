import { type StreamChunk, toServerSentEventsResponse } from "@tanstack/ai";
import { BaseTextAdapter, chat } from "@tanstack/ai/adapters";
import { geminiText } from "@tanstack/ai-gemini";
import type { Context } from "hono";
import { Hono } from "hono";
import type { User } from "../auth/users.js";
import type { CopilotSnapshot, TicketStore } from "./store.js";

// copilot (spec: specs/copilot.md) — a Hono route (not oRPC) that answers
// cross-ticket status questions. The numbers come only from a SQL snapshot
// (store.copilotSnapshot); the LLM never counts. Reuses reply-draft's SSE wire
// (draft.ts): the same @tanstack/ai AG-UI stream useChat parses on the client.

// Provider selection mirrors draft.ts: mock is the default; gemini requires a
// key or the whole request is 500 provider_misconfigured — never a silent mock
// fallback, so the nightly smoke lane can't go falsely green.
class ProviderMisconfiguredError extends Error {}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

// The fixed line the deterministic mock adapter streams for any prompt carrying
// the stats fence. E2E anchors on this exact text (it references SUP-1 so the
// ref-link path has something to click), so keep it verbatim and in lockstep
// with the E2E mock. 文言は完全一致で固定(spec)。
export const MOCK_COPILOT_REPLY =
  "現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。";

// The stats fence (spec): the snapshot JSON is wrapped so the evals judge can
// anchor on it and so user input can never forge or terminate the fence.
const STATS_OPEN = "<<<STATS>>>";
const STATS_CLOSE = "<<<END_STATS>>>";

// Neutralise the fence delimiters in untrusted text (the client's messages), the
// same way evals/judge fences the draft: a message that names <<<STATS>>> /
// <<<END_STATS>>> can't close the snapshot fence early or open a fake one.
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

// One user turn carrying the fenced snapshot JSON followed by the conversation.
// The snapshot is fenced so the judge can locate it; the client's messages are
// neutralised so they can't forge the fence. The fence markers are load-bearing
// (the mock adapter and the evals judge both key on STATS_OPEN).
export function buildCopilotPrompt(
  snapshot: CopilotSnapshot,
  messages: Array<{ role: string; content: string }>,
): Array<{ role: "user"; content: string }> {
  const conversation = messages.map((m) => `${m.role}: ${neutralizeStats(m.content)}`).join("\n");
  const content = [
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

// Deterministic mock adapter: emits the AG-UI lifecycle for the fixed copilot
// line whenever the prompt carries the stats fence (the route always fences, so
// the mock always answers the fixed line). Same interface a real provider
// adapter implements (geminiText) — switching is an env concern, never a
// test-code concern.
class MockCopilotAdapter extends BaseTextAdapter<
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
    const runId = options.runId ?? "copilot-run";
    const threadId = options.threadId ?? "copilot-thread";
    const messageId = "copilot-msg";
    const reply = hasStatsFence(options.messages) ? MOCK_COPILOT_REPLY : "";

    yield { type: "RUN_STARTED", threadId, runId } as unknown as StreamChunk;
    yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as unknown as StreamChunk;
    for (const delta of copilotDeltas(reply)) {
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta } as unknown as StreamChunk;
    }
    yield { type: "TEXT_MESSAGE_END", messageId } as unknown as StreamChunk;
    yield { type: "RUN_FINISHED", threadId, runId } as unknown as StreamChunk;
  }

  async structuredOutput(): Promise<never> {
    throw new Error("structuredOutput is not supported by the mock copilot adapter");
  }
}

function hasStatsFence(messages: Array<{ role: string; content: unknown }>): boolean {
  return messages.some((m) => typeof m.content === "string" && m.content.includes(STATS_OPEN));
}

// Split the fixed line into a couple of deltas so the mock mirrors real chunked
// streaming (content is the join). An empty reply yields no content deltas.
function copilotDeltas(text: string): string[] {
  if (text === "") return [];
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

function selectCopilotStream(
  snapshot: CopilotSnapshot,
  messages: Array<{ role: string; content: string }>,
): AsyncIterable<StreamChunk> {
  const kind = process.env.LLM_PROVIDER ?? "mock";
  const chatMessages = buildCopilotPrompt(snapshot, messages);
  const systemPrompts = [buildCopilotSystemPrompt()];

  if (kind === "gemini") {
    let adapter: ReturnType<typeof geminiText>;
    try {
      adapter = geminiText(GEMINI_MODEL as Parameters<typeof geminiText>[0]);
    } catch {
      throw new ProviderMisconfiguredError();
    }
    return chat({ adapter, messages: chatMessages, systemPrompts });
  }

  return chat({ adapter: new MockCopilotAdapter(), messages: chatMessages, systemPrompts });
}

// The client's conversation history. useChat sends AG-UI messages whose text is
// carried in `parts`; a plain unit request may send { role, content }. Accept
// both and normalise to { role, content } so the same route serves the
// deterministic unit contract and the live useChat client.
function messagesFromBody(body: unknown): Array<{ role: string; content: string }> {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ role: string; content: string }> = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) continue;
    const role =
      typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : "user";
    const content = messageContent(m);
    if (content !== "") out.push({ role, content });
  }
  return out;
}

// A message's text is either a plain string `content` or the join of its AG-UI
// text parts (useChat wire).
function messageContent(m: object): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  const parts = (m as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    return parts
      .filter(
        (p): p is { type: "text"; content: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { content?: unknown }).content === "string",
      )
      .map((p) => p.content)
      .join("");
  }
  return "";
}

// Dependencies injected from app.ts so the route stays free of pool/session
// wiring (parallels draft.ts). streamFor is injectable so a unit test can
// capture the assembled prompt without a real provider (evals/run deps 注入の流儀).
export type CopilotDeps = {
  resolveUser: (c: Context) => Promise<User | null>;
  ticketStore: () => TicketStore;
  streamFor?: (
    snapshot: CopilotSnapshot,
    messages: Array<{ role: string; content: string }>,
  ) => AsyncIterable<StreamChunk>;
};

export function createCopilotRouter(deps: CopilotDeps) {
  const router = new Hono();
  const streamFor = deps.streamFor ?? selectCopilotStream;

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

    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = streamFor(snapshot, messages);
    } catch (err) {
      if (err instanceof ProviderMisconfiguredError) {
        return c.json({ error: "provider_misconfigured" }, 500);
      }
      throw err;
    }

    return toServerSentEventsResponse(stream as AsyncIterable<StreamChunk>);
  });

  return router;
}
