import type { ChatMessage, LLMProvider } from "./provider.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function replyFor(input: string): string {
  return `You said: "${input.trim()}". This is a deterministic reply from the mock provider used for E2E tests.`;
}

// copilot (spec: specs/copilot.md「MockProvider の拡張」): a composed prompt
// carrying the <<<STATS>>> anchor gets this fixed line back, verbatim. It is the
// E2E happy-path anchor — copilot-assistant matches this text and SUP-1 is the
// copilot-ref target — so keep it in exact lockstep with the E2E mock. 文言は完全一致で固定。
export const COPILOT_STATS_ANCHOR = "<<<STATS>>>";
export const COPILOT_FIXED_REPLY =
  "現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。";

// Split the fixed line into a few deltas so the mock mirrors real chunked
// streaming; the join is the whole line (the contract mock-provider.test asserts).
function copilotDeltas(text: string): string[] {
  const third = Math.floor(text.length / 3);
  return [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)];
}

// Deterministic provider: same input always yields the same chunk sequence.
// Real providers implement the same interface; switching is an env concern,
// never a test-code concern.
export class MockProvider implements LLMProvider {
  constructor(private readonly delayMs: number = Number(process.env.MOCK_DELAY_MS ?? 30)) {}

  async *stream(messages: ChatMessage[]): AsyncIterable<string> {
    const last = messages.at(-1)?.content ?? "";
    if (last === "__stream_error__") {
      yield "Partial ";
      throw new Error("mock provider mid-stream failure");
    }
    // copilot: the route composes the snapshot behind a <<<STATS>>> fence, so a
    // prompt carrying the anchor (in any message) gets the fixed status line.
    // Everything else keeps the default echo (chat / reply-draft の既存契約)。
    if (messages.some((m) => m.content.includes(COPILOT_STATS_ANCHOR))) {
      for (const delta of copilotDeltas(COPILOT_FIXED_REPLY)) {
        yield delta;
        if (this.delayMs > 0) await sleep(this.delayMs);
      }
      return;
    }
    const words = replyFor(last).split(" ");
    for (const [i, word] of words.entries()) {
      yield i === words.length - 1 ? word : `${word} `;
      if (this.delayMs > 0) await sleep(this.delayMs);
    }
  }
}
