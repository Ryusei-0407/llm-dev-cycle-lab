import { describe, expect, it } from "vitest";
import { ChatState, chatReducer, initialState } from "../src/chat/reducer";

const started = (): ChatState => chatReducer(initialState, { type: "start", content: "hi" });

describe("chatReducer", () => {
  it("start appends the user message and an empty assistant slot", () => {
    const state = started();
    expect(state.status).toBe("streaming");
    expect(state.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]);
  });

  it("delta accumulates into the assistant message", () => {
    let state = started();
    state = chatReducer(state, { type: "delta", delta: "Hel" });
    state = chatReducer(state, { type: "delta", delta: "lo" });
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "Hello" });
  });

  it("error before any delta drops the empty assistant bubble", () => {
    const state = chatReducer(started(), { type: "error", message: "boom" });
    expect(state.error).toBe("boom");
    expect(state.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("error after partial output keeps the partial text", () => {
    let state = started();
    state = chatReducer(state, { type: "delta", delta: "Partial " });
    state = chatReducer(state, { type: "error", message: "stream_failed" });
    expect(state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Partial ",
    });
    expect(state.error).toBe("stream_failed");
  });
});
