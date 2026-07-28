import type { ChatMessage, LLMProvider } from './provider.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function replyFor(input: string): string {
  return `You said: "${input.trim()}". This is a deterministic reply from the mock provider used for E2E tests.`;
}

// Deterministic provider: same input always yields the same chunk sequence.
// Real providers implement the same interface; switching is an env concern,
// never a test-code concern.
export class MockProvider implements LLMProvider {
  constructor(
    private readonly delayMs: number = Number(process.env.MOCK_DELAY_MS ?? 30),
  ) {}

  async *stream(messages: ChatMessage[]): AsyncIterable<string> {
    const last = messages.at(-1)?.content ?? '';
    if (last === '__stream_error__') {
      yield 'Partial ';
      throw new Error('mock provider mid-stream failure');
    }
    const words = replyFor(last).split(' ');
    for (const [i, word] of words.entries()) {
      yield i === words.length - 1 ? word : `${word} `;
      if (this.delayMs > 0) await sleep(this.delayMs);
    }
  }
}
