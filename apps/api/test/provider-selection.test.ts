import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// Provider selection (specs/gemini-provider.md) is exercised through the public
// /api/chat surface, not an internal factory: LLM_PROVIDER + GEMINI_API_KEY are
// read at app construction / request time and the only observable difference is
// the HTTP response. This keeps the test decoupled from the internal wiring.
//
// These tests mutate process.env, so LLM_PROVIDER and GEMINI_API_KEY are saved
// and fully restored around every case. A leaked LLM_PROVIDER=gemini would make
// unrelated /api/chat tests attempt a real network call — the M1 review caught
// exactly this class of cross-test env pollution, so restoration is mandatory.

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const HI = { messages: [{ role: "user", content: "hi" }] };

let savedProvider: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedProvider = process.env.LLM_PROVIDER;
  savedKey = process.env.GEMINI_API_KEY;
  process.env.MOCK_DELAY_MS = "0";
});

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

describe("provider selection", () => {
  it("defaults to the mock provider when LLM_PROVIDER is unset", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    const res = await post(createApp(), HI);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"delta"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("uses the mock provider when LLM_PROVIDER=mock", async () => {
    process.env.LLM_PROVIDER = "mock";
    delete process.env.GEMINI_API_KEY;
    const res = await post(createApp(), HI);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("returns 500 provider_misconfigured for gemini without an API key", async () => {
    process.env.LLM_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;
    const res = await post(createApp(), HI);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "provider_misconfigured" });
  });
});
