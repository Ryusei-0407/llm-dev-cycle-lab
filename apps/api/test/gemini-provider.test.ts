import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/llm/provider.js";
// gemini.ts does not exist yet (RED). The spec (specs/gemini-provider.md) fixes
// the public shape: a GeminiProvider implementing LLMProvider whose constructor
// accepts an injectable client, so unit tests never touch the real network.
import { GeminiProvider } from "../src/llm/gemini.js";

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

// A fake shaped like the @google/genai client surface the provider consumes:
// `client.models.generateContentStream({ model, contents })` resolves to an
// async-iterable of chunks, each exposing an optional `.text`. The provider is
// injected with this instead of a real GoogleGenAI instance (no network).
type Chunk = { text?: string };

function fakeClient(script: () => AsyncIterable<Chunk>) {
  const calls: Array<{ model: string; contents: unknown }> = [];
  const client = {
    models: {
      generateContentStream(args: { model: string; contents: unknown }) {
        calls.push({ model: args.model, contents: args.contents });
        return Promise.resolve(script());
      },
    },
  };
  return { client, calls };
}

async function* fromChunks(chunks: Chunk[]): AsyncIterable<Chunk> {
  for (const chunk of chunks) yield chunk;
}

const HELLO: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("GeminiProvider", () => {
  it("yields chunk text as deltas in order", async () => {
    const { client } = fakeClient(() =>
      fromChunks([{ text: "Hel" }, { text: "lo" }, { text: "!" }]),
    );
    const provider = new GeminiProvider(client);
    expect(await collect(provider.stream(HELLO))).toEqual(["Hel", "lo", "!"]);
  });

  it("skips chunks that carry no text (empty/undefined)", async () => {
    const { client } = fakeClient(() =>
      fromChunks([{ text: "a" }, {}, { text: "" }, { text: undefined }, { text: "b" }]),
    );
    const provider = new GeminiProvider(client);
    expect(await collect(provider.stream(HELLO))).toEqual(["a", "b"]);
  });

  it("propagates a mid-stream error by throwing", async () => {
    async function* boom(): AsyncIterable<Chunk> {
      yield { text: "partial" };
      throw new Error("gemini upstream exploded");
    }
    const { client } = fakeClient(boom);
    const provider = new GeminiProvider(client);
    await expect(collect(provider.stream(HELLO))).rejects.toThrow("gemini upstream exploded");
  });

  it("requests the gemini-2.5-flash model", async () => {
    const { client, calls } = fakeClient(() => fromChunks([{ text: "x" }]));
    const provider = new GeminiProvider(client);
    await collect(provider.stream(HELLO));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("gemini-2.5-flash");
  });
});
