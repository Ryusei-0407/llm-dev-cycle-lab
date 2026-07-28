import { describe, expect, it } from "vitest";
import { createSSEParser } from "../src/chat/parseSSE";

describe("createSSEParser", () => {
  it("parses complete events", () => {
    const parser = createSSEParser();
    const events = parser.feed(
      'data: {"delta":"Hello "}\n\ndata: {"delta":"world"}\n\ndata: [DONE]\n\n',
    );
    expect(events).toEqual([{ delta: "Hello " }, { delta: "world" }, "DONE"]);
  });

  it("handles events split across chunk boundaries", () => {
    const parser = createSSEParser();
    expect(parser.feed('data: {"del')).toEqual([]);
    expect(parser.feed('ta":"Hi"}\n')).toEqual([]);
    expect(parser.feed("\n")).toEqual([{ delta: "Hi" }]);
  });

  it("parses error events and ignores malformed data", () => {
    const parser = createSSEParser();
    const events = parser.feed('data: not-json\n\ndata: {"error":"stream_failed"}\n\n');
    expect(events).toEqual([{ error: "stream_failed" }]);
  });
});
