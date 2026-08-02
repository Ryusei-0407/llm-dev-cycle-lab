import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases } from "../evals/cases.js";

// evals-expansion (spec: specs/evals-expansion.md): nightly evals のケースを
// 7 → 12 に拡充する。ランナー / judge は変更せず、追加 JSON とその規約テスト
// のみ。ケース JSON がまだ無い状態では全テストが RED になる。
//
// bundledDir は同梱ケースディレクトリ(apps/api/evals/cases)を loadCases に
// かける。loadCases のスキーマ検証を通ること自体が「一般規約の通過」の一部。
const bundledDir = fileURLToPath(new URL("../evals/cases", import.meta.url));

// 仕様「追加ケース(apps/api/evals/cases/ に JSON 5件)」の id 列挙。
// thread-grounding アンカーの遡及検証を新5ケースに限定するためにも使う。
const NEW_CASE_IDS = [
  "refund-decline",
  "japanese-inquiry",
  "credential-safety",
  "copilot-unassigned",
  "copilot-stale",
] as const;

function threadBody(evalCase: { messages: Array<{ body: string }> }): string {
  return evalCase.messages.map((m) => m.body).join("\n");
}

describe("evals-expansion new cases", () => {
  it(
    "新5ケースが id で存在し、evals 一般規約(schema + leak guard)を通る",
    {
      annotation: {
        type: "description",
        description:
          "仕様が追加を求める5ケース(refund-decline / japanese-inquiry / credential-safety / copilot-unassigned / copilot-stale)が同梱され、loadCases のスキーマ検証を通過し、各ケースが system-prompt leak guard 語を mustNotMention に持つことを検証",
      },
    },
    () => {
      const cases = loadCases(bundledDir);
      const byId = new Map(cases.map((c) => [c.id, c]));
      for (const id of NEW_CASE_IDS) {
        const evalCase = byId.get(id);
        expect(evalCase, `case ${id} が同梱ケースに存在すること`).toBeDefined();
        // 仕様 unit観点: 既存 evals の一般規約(全ケースが leak guard を持つ)を
        // 新ケースも満たす。既存 evals-cases.test.ts と同じ判定。
        const guards = (evalCase?.mustNotMention ?? []).map((w) => w.toLowerCase());
        expect(
          guards.some((w) => w.includes("you are a support agent")),
          `case ${id} は "you are a support agent" leak guard を mustNotMention に含むこと`,
        ).toBe(true);
      }
    },
  );

  it(
    "新5ケースの mustMention 各語がスレッド本文の連結に文字どおり含まれる(thread-grounding)",
    {
      annotation: {
        type: "description",
        description:
          "新5ケースについて mustMention の各値がそのケースの messages 本文の連結に文字どおり出現することを検証。同義語依存アンカー(本文に無い語)の混入をビルド時に落とす",
      },
    },
    () => {
      const cases = loadCases(bundledDir);
      const byId = new Map(cases.map((c) => [c.id, c]));
      for (const id of NEW_CASE_IDS) {
        const evalCase = byId.get(id);
        expect(evalCase, `case ${id} が同梱ケースに存在すること`).toBeDefined();
        if (!evalCase) continue;
        const body = threadBody(evalCase);
        for (const term of evalCase.mustMention) {
          expect(
            body.includes(term),
            `case ${id}: mustMention "${term}" がスレッド本文に文字どおり含まれること(thread-fact anchor)`,
          ).toBe(true);
        }
      }
    },
  );
});

describe("evals-expansion quota watchdog", () => {
  it(
    "同梱ケース総数がちょうど 12 件である",
    {
      annotation: {
        type: "description",
        description:
          "同梱ケース総数が 12 件ちょうどであることを検証。nightly の Gemini free tier は生成/judge 各 20 req/日で、1ケース = 生成1 + judge1。13件以上は quota(20/日)を静かに超過させるため番犬として固定する",
      },
    },
    () => {
      const cases = loadCases(bundledDir);
      // quota: 生成 20 req/日・judge 20 req/日。1ケース = 生成1 + judge1 なので
      // 12ケース = 12 + 12 req で quota 内。13件以上は nightly を quota 超過で
      // 静かに壊すため、この本数を固定して増加を検知する(specs/evals-expansion.md)。
      expect(cases.length).toBe(12);
    },
  );
});
