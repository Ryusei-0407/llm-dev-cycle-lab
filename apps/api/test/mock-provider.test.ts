import { describe, expect, it } from "vitest";
import { MockProvider, replyFor } from "../src/llm/mock.js";

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

describe("MockProvider", () => {
  it("returns the same chunk sequence for the same input", async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: "user" as const, content: "hello" }];
    const first = await collect(provider.stream(messages));
    const second = await collect(provider.stream(messages));
    expect(first).toEqual(second);
    expect(first.join("")).toBe(replyFor("hello"));
  });

  it("throws mid-stream for the __stream_error__ trigger", async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: "user" as const, content: "__stream_error__" }];
    await expect(collect(provider.stream(messages))).rejects.toThrow("mid-stream failure");
  });

  // copilot (spec: specs/copilot.md「MockProvider の拡張」): a prompt carrying the
  // <<<STATS>>> anchor gets a fixed line back, verbatim. This is the E2E happy
  // path's anchor (SUP-1 の参照 + copilot-assistant の固定文照合)。文言は完全一致で固定。
  const COPILOT_FIXED =
    "現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。";

  it("returns the fixed copilot line verbatim for a <<<STATS>>> prompt", async () => {
    const provider = new MockProvider(0);
    const messages = [
      {
        role: "user" as const,
        content: 'システム指示\n<<<STATS>>>\n{"unassigned":1}\n<<<END_STATS>>>\n全体の進行状況は?',
      },
    ];
    const chunks = await collect(provider.stream(messages));
    expect(chunks.join("")).toBe(COPILOT_FIXED);
  });

  it("mentions SUP-1 in the fixed copilot line (E2E の copilot-ref アンカー)", async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: "user" as const, content: "<<<STATS>>>{}<<<END_STATS>>>" }];
    const text = (await collect(provider.stream(messages))).join("");
    expect(text).toContain("SUP-1");
  });

  it("keeps the default reply for prompts without the <<<STATS>>> anchor", async () => {
    const provider = new MockProvider(0);
    const messages = [{ role: "user" as const, content: "hello" }];
    const text = (await collect(provider.stream(messages))).join("");
    // STATS を含まない通常プロンプトは copilot 固定文にはならない(既定の replyFor)。
    expect(text).toBe(replyFor("hello"));
    expect(text).not.toBe(COPILOT_FIXED);
  });
});
