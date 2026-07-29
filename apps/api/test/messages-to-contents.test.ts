import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/llm/provider.js";
// Exported alongside GeminiProvider from gemini.ts (does not exist yet — RED).
// Converts our ChatMessage[] into the Gemini `contents` shape: an array of
// { role, parts: [{ text }] } where the assistant role maps to "model".
import { messagesToContents } from "../src/llm/gemini.js";

describe("messagesToContents", () => {
  it("maps user messages to role 'user'", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi there" }];
    expect(messagesToContents(messages)).toEqual([{ role: "user", parts: [{ text: "hi there" }] }]);
  });

  it("maps assistant messages to Gemini's 'model' role", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "hello back" }];
    expect(messagesToContents(messages)).toEqual([
      { role: "model", parts: [{ text: "hello back" }] },
    ]);
  });

  it("preserves order across a multi-turn conversation", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    expect(messagesToContents(messages)).toEqual([
      { role: "user", parts: [{ text: "q1" }] },
      { role: "model", parts: [{ text: "a1" }] },
      { role: "user", parts: [{ text: "q2" }] },
    ]);
  });
});
