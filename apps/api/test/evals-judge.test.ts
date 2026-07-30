import { describe, expect, it } from "vitest";
import { buildJudgePrompt } from "../evals/judge.js";
import type { EvalCase } from "../evals/types.js";

// evals (spec: specs/evals.md) MUST 5: buildJudgePrompt expands the three-item
// rubric (忠実性 / 応答性 / トーン), the ticket context (subject + every thread
// message body), the draft under evaluation, and the JSON-only verdict
// instruction ({"score": 1-5, "reasoning": ...}) into a single prompt string.
// The real LLM call (realJudge) is exercised by the nightly evals job, not here.

const evalCase: EvalCase = {
  id: "billing-dispute",
  ticket: {
    subject: "Charged twice for the March invoice",
    status: "open",
    priority: "high",
    requesterEmail: "customer@example.com",
  },
  messages: [
    {
      authorRole: "customer",
      authorEmail: "customer@example.com",
      body: "I was charged $49 twice on March 3rd, invoice INV-2031.",
    },
    {
      authorRole: "agent",
      authorEmail: "agent@example.com",
      body: "Could you share the last four digits of the card?",
    },
  ],
  mustMention: ["refund"],
  mustNotMention: ["you are a support agent"],
};

const draft =
  "Thanks for flagging the duplicate charge on invoice INV-2031. We have issued a refund for the extra $49; it should appear within 5 business days.";

describe("buildJudgePrompt", () => {
  it(
    "ルーブリック3項目(忠実性・応答性・トーン)が全て含まれる",
    {
      annotation: {
        type: "description",
        description:
          "judge プロンプトに採点ルーブリックの3観点(忠実性・応答性・トーン)がすべて展開されることを検証",
      },
    },
    () => {
      const prompt = buildJudgePrompt(evalCase, draft);
      expect(prompt).toContain("忠実性");
      expect(prompt).toContain("応答性");
      expect(prompt).toContain("トーン");
    },
  );

  it(
    "チケット文脈(件名と全メッセージ本文)が含まれる",
    {
      annotation: {
        type: "description",
        description:
          "judge プロンプトにチケット件名とスレッド全メッセージの本文が含まれることを検証(忠実性採点の前提となる文脈)",
      },
    },
    () => {
      const prompt = buildJudgePrompt(evalCase, draft);
      expect(prompt).toContain(evalCase.ticket.subject);
      for (const message of evalCase.messages) {
        expect(prompt).toContain(message.body);
      }
    },
  );

  it(
    "採点対象のドラフト本文が含まれる",
    {
      annotation: {
        type: "description",
        description: "judge プロンプトに採点対象のドラフト全文がそのまま含まれることを検証",
      },
    },
    () => {
      const prompt = buildJudgePrompt(evalCase, draft);
      expect(prompt).toContain(draft);
    },
  );

  it(
    "JSON 判定指示(score / reasoning)が含まれる",
    {
      annotation: {
        type: "description",
        description:
          'judge プロンプトに JSON のみで返す指示({"score", "reasoning"} のキー名と JSON への言及)が含まれることを検証',
      },
    },
    () => {
      const prompt = buildJudgePrompt(evalCase, draft);
      expect(prompt).toContain("score");
      expect(prompt).toContain("reasoning");
      expect(prompt).toMatch(/json/i);
    },
  );
});
