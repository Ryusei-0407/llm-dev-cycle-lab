import { type GoogleGenAI, Type } from "@google/genai";
import { parseJudgeVerdict } from "./scoring.js";
import type { EvalCase, JudgeVerdict } from "./types.js";

// LLM-as-judge prompt: rubric + ticket context + draft in one user turn.
// The rubric text mirrors specs/evals.md verbatim.
export function buildJudgePrompt(evalCase: EvalCase, draft: string): string {
  const thread = evalCase.messages
    .map((m) => `${m.authorRole} (${m.authorEmail}): ${m.body}`)
    .join("\n");
  return [
    "あなたはサポートデスクの返信ドラフトの品質を採点する審査員です。",
    "以下のルーブリックで 1..5 の整数で採点してください。",
    "全て満たすとき 5、致命的な問題(事実の捏造、別チケットへの回答、無礼)があれば 1-2:",
    "",
    "1. 忠実性: スレッドに無い事実・仕様・URL を捏造していない",
    "2. 応答性: 顧客の最新メッセージの要求・質問に直接応えている",
    "3. トーン: 丁寧・簡潔・顧客宛の返信文としてそのまま送れる体裁",
    "",
    "チケット文脈:",
    `Subject: ${evalCase.ticket.subject}`,
    `Status: ${evalCase.ticket.status} | Priority: ${evalCase.ticket.priority} | Requester: ${evalCase.ticket.requesterEmail}`,
    "Thread:",
    thread,
    "",
    "評価対象のドラフト:",
    draft,
    "",
    '判定は {"score": <1-5>, "reasoning": "<簡潔な根拠>"} の JSON のみを出力してください。',
  ].join("\n");
}

export type JudgeFn = (evalCase: EvalCase, draft: string) => Promise<JudgeVerdict>;

// Real judge: @google/genai JSON mode (responseMimeType + responseSchema) so
// the response text is machine-parseable without prompt-only JSON coaxing.
export function realJudge(client: GoogleGenAI, model: string): JudgeFn {
  return async (evalCase, draft) => {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: buildJudgePrompt(evalCase, draft) }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER },
            reasoning: { type: Type.STRING },
          },
          required: ["score", "reasoning"],
        },
      },
    });
    return parseJudgeVerdict(response.text ?? "");
  };
}
