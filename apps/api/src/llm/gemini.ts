import type { ChatMessage, LLMProvider } from "./provider.js";

// Gemini `contents` shape. The assistant role maps to Gemini's "model" role;
// user stays "user".
export interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

export function messagesToContents(messages: ChatMessage[]): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

// The subset of the @google/genai client surface the provider consumes. Kept
// minimal so unit tests can inject a fake without the real SDK or network.
export interface GeminiChunk {
  text?: string;
}

export interface GeminiClient {
  models: {
    generateContentStream(args: {
      model: string;
      contents: GeminiContent[];
    }): Promise<AsyncIterable<GeminiChunk>>;
  };
}

// gemini-flash-latest は常に現行世代を指すエイリアス。固定名(例: gemini-2.5-flash)は
// 新規キーに対して提供終了となり 404 を返すことがある(2026-07 に実測)
const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

export class GeminiProvider implements LLMProvider {
  constructor(private readonly client: GeminiClient) {}

  async *stream(messages: ChatMessage[]): AsyncIterable<string> {
    const contents = messagesToContents(messages);
    const iterable = await this.client.models.generateContentStream({ model: MODEL, contents });
    for await (const chunk of iterable) {
      const text = chunk.text;
      if (text) yield text;
    }
  }
}
