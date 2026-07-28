import { describe, expect, it } from 'vitest';
import { MockProvider, replyFor } from '../src/llm/mock.js';

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

describe('MockProvider', () => {
  it('returns the same chunk sequence for the same input', async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const first = await collect(provider.stream(messages));
    const second = await collect(provider.stream(messages));
    expect(first).toEqual(second);
    expect(first.join('')).toBe(replyFor('hello'));
  });

  it('throws mid-stream for the __stream_error__ trigger', async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: 'user' as const, content: '__stream_error__' }];
    await expect(collect(provider.stream(messages))).rejects.toThrow(
      'mid-stream failure',
    );
  });
});
