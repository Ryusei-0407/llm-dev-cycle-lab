import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

beforeAll(() => {
  process.env.MOCK_DELAY_MS = '0';
});

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat', () => {
  it('rejects a body without messages', async () => {
    const res = await post(createApp(), {});
    expect(res.status).toBe(400);
  });

  // Pinned by adversarial review: removing the JSON try/catch turned this
  // into a 500 without any test noticing.
  it('rejects malformed JSON with 400', async () => {
    const res = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 500 for the __error__ trigger', async () => {
    const res = await post(createApp(), {
      messages: [{ role: 'user', content: '__error__' }],
    });
    expect(res.status).toBe(500);
  });

  it('streams SSE deltas terminated by [DONE]', async () => {
    const res = await post(createApp(), {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"delta"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('emits a stream_failed event when the provider dies mid-stream', async () => {
    const res = await post(createApp(), {
      messages: [{ role: 'user', content: '__stream_error__' }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('stream_failed');
    expect(text).not.toContain('[DONE]');
  });
});
