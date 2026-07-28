import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MockProvider } from './llm/mock.js';
import type { ChatMessage, LLMProvider } from './llm/provider.js';

function getProvider(): LLMProvider {
  // Only the mock provider exists for now. A real provider (Anthropic, etc.)
  // slots in here behind the same interface, selected via LLM_PROVIDER.
  return new MockProvider();
}

export function createApp() {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const messages = (body as { messages?: unknown })?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'messages required' }, 400);
    }
    const last = messages[messages.length - 1] as ChatMessage | undefined;
    if (last?.content === '__error__') {
      return c.json({ error: 'provider failure' }, 500);
    }

    const provider = getProvider();
    return streamSSE(c, async (stream) => {
      try {
        for await (const delta of provider.stream(messages as ChatMessage[])) {
          await stream.writeSSE({ data: JSON.stringify({ delta }) });
        }
        await stream.writeSSE({ data: '[DONE]' });
      } catch {
        await stream.writeSSE({ data: JSON.stringify({ error: 'stream_failed' }) });
      }
    });
  });

  return app;
}
