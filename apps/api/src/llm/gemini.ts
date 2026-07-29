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

const MODEL = "gemini-2.5-flash";

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
