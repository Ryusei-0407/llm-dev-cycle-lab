import { describe, expect, it } from "vitest";
import { parseJudgeVerdict, runProgrammaticChecks, summarize } from "../evals/scoring.js";
import type { CaseResult, CheckResult, EvalCase, JudgeVerdict } from "../evals/types.js";

// evals (spec: specs/evals.md) MUST 2-4: pure scoring logic.
// - runProgrammaticChecks returns exactly ["length", "must-mention",
//   "must-not-mention"] in that order; mention matching is lowercased substring
//   matching; length defaults are 80/1600.
// - parseJudgeVerdict accepts {score: 1..5 integer, reasoning: string} JSON and
//   throws with "judge verdict" in the message otherwise.
// - summarize derives Summary.pass from programmaticFailures === 0 &&
//   rubricPassRate >= 0.8 && no error && no null verdict.

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    ticket: {
      subject: "Cannot reset my password",
      status: "open",
      priority: "high",
      requesterEmail: "customer@example.com",
    },
    messages: [
      {
        authorRole: "customer",
        authorEmail: "customer@example.com",
        body: "The reset link says 'token expired' right after it arrives.",
      },
    ],
    mustMention: ["reset"],
    ...overrides,
  };
}

function checkByName(checks: CheckResult[], name: string): CheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`check "${name}" not found in ${JSON.stringify(checks)}`);
  return found;
}

describe("runProgrammaticChecks", () => {
  it(
    "checks を固定の名前・順序(length / must-mention / must-not-mention)で返す",
    {
      annotation: {
        type: "description",
        description:
          "runProgrammaticChecks が name 固定の3チェックを仕様の順序で返すことを検証(レポート構造の安定性)",
      },
    },
    () => {
      const checks = runProgrammaticChecks("please reset here".repeat(10), makeCase());
      expect(checks.map((c) => c.name)).toEqual(["length", "must-mention", "must-not-mention"]);
    },
  );

  it(
    "length: minChars ちょうど・maxChars ちょうどは pass、1字外れると fail",
    {
      annotation: {
        type: "description",
        description:
          "length チェックの境界(ちょうど minChars / maxChars は合格、その±1字は不合格)を検証",
      },
    },
    () => {
      const evalCase = makeCase({ mustMention: [], minChars: 10, maxChars: 20 });
      const lengthCheck = (draft: string) =>
        checkByName(runProgrammaticChecks(draft, evalCase), "length");
      expect(lengthCheck("x".repeat(10)).pass).toBe(true);
      expect(lengthCheck("x".repeat(9)).pass).toBe(false);
      expect(lengthCheck("x".repeat(20)).pass).toBe(true);
      expect(lengthCheck("x".repeat(21)).pass).toBe(false);
    },
  );

  it(
    "length: minChars / maxChars 省略時は既定 80 / 1600 を使う",
    {
      annotation: {
        type: "description",
        description: "minChars/maxChars 未指定のケースで既定値 80/1600 が適用されることを検証",
      },
    },
    () => {
      const evalCase = makeCase({ mustMention: [] });
      const lengthCheck = (draft: string) =>
        checkByName(runProgrammaticChecks(draft, evalCase), "length");
      expect(lengthCheck("x".repeat(79)).pass).toBe(false);
      expect(lengthCheck("x".repeat(80)).pass).toBe(true);
      expect(lengthCheck("x".repeat(1600)).pass).toBe(true);
      expect(lengthCheck("x".repeat(1601)).pass).toBe(false);
    },
  );

  it(
    "must-mention: 大文字小文字を無視した部分一致で全語が含まれれば pass",
    {
      annotation: {
        type: "description",
        description:
          "mustMention の全語が小文字化した部分一致でドラフトに見つかるとき must-mention チェックが合格することを検証(大文字混じりドラフト)",
      },
    },
    () => {
      const evalCase = makeCase({ mustMention: ["reset", "password"] });
      const checks = runProgrammaticChecks(
        "Please RESET your Password using the link below.",
        evalCase,
      );
      expect(checkByName(checks, "must-mention").pass).toBe(true);
    },
  );

  it(
    "must-mention: 欠落があれば fail し、detail に欠落語を列挙する",
    {
      annotation: {
        type: "description",
        description:
          "mustMention の一部語が欠けるとき must-mention チェックが不合格になり、detail に欠落語が列挙されることを検証",
      },
    },
    () => {
      const evalCase = makeCase({ mustMention: ["reset", "refund"] });
      const checks = runProgrammaticChecks(
        "Please reset your password using the link below.",
        evalCase,
      );
      const mention = checkByName(checks, "must-mention");
      expect(mention.pass).toBe(false);
      expect(mention.detail).toContain("refund");
    },
  );

  it(
    "must-not-mention: 禁止語が(大文字違いでも)含まれると fail し、detail に検出語を列挙する",
    {
      annotation: {
        type: "description",
        description:
          "mustNotMention の語が大文字違いでドラフトに含まれるとき must-not-mention チェックが不合格になり、detail に検出語が載ることを検証(プロンプト漏洩検知)",
      },
    },
    () => {
      const evalCase = makeCase({
        mustMention: [],
        mustNotMention: ["you are a support agent"],
      });
      const checks = runProgrammaticChecks(
        "You Are A Support Agent. Please reply to the customer politely.",
        evalCase,
      );
      const notMention = checkByName(checks, "must-not-mention");
      expect(notMention.pass).toBe(false);
      expect(notMention.detail).toContain("you are a support agent");
    },
  );

  it(
    "must-not-mention: 禁止語が無ければ pass、mustNotMention 省略時(既定 [])も pass",
    {
      annotation: {
        type: "description",
        description:
          "禁止語が含まれないドラフト、および mustNotMention 未指定(既定 空配列)のケースで must-not-mention チェックが合格することを検証",
      },
    },
    () => {
      const withList = makeCase({ mustMention: [], mustNotMention: ["you are a support agent"] });
      const clean = runProgrammaticChecks("Thanks for reaching out about the link.", withList);
      expect(checkByName(clean, "must-not-mention").pass).toBe(true);

      const omitted = makeCase({ mustMention: [] });
      const defaulted = runProgrammaticChecks("Thanks for reaching out about the link.", omitted);
      expect(checkByName(defaulted, "must-not-mention").pass).toBe(true);
    },
  );
});

describe("parseJudgeVerdict", () => {
  it(
    "正常な JSON({score, reasoning})を JudgeVerdict として返す",
    {
      annotation: {
        type: "description",
        description:
          "judge 応答の正常 JSON が {score, reasoning} にパースされ、境界値 1 と 5 も受理されることを検証",
      },
    },
    () => {
      expect(parseJudgeVerdict('{"score": 4, "reasoning": "faithful and polite"}')).toEqual({
        score: 4,
        reasoning: "faithful and polite",
      });
      expect(parseJudgeVerdict('{"score": 1, "reasoning": "fabricated facts"}').score).toBe(1);
      expect(parseJudgeVerdict('{"score": 5, "reasoning": "perfect"}').score).toBe(5);
    },
  );

  it(
    "JSON でない応答は 'judge verdict' 入りの Error を throw する",
    {
      annotation: {
        type: "description",
        description:
          "JSON としてパースできない judge 応答で throw し、メッセージに 'judge verdict' が含まれることを検証",
      },
    },
    () => {
      expect(() => parseJudgeVerdict("I would rate this a 4 out of 5.")).toThrowError(
        /judge verdict/,
      );
    },
  );

  it(
    "score が 1..5 の整数でない場合は throw する(0 / 6 / 3.5 / 文字列)",
    {
      annotation: {
        type: "description",
        description:
          "score の範囲外(0, 6)・非整数(3.5)・非数値('4')がすべて 'judge verdict' 入りの Error になることを検証",
      },
    },
    () => {
      for (const raw of [
        '{"score": 0, "reasoning": "r"}',
        '{"score": 6, "reasoning": "r"}',
        '{"score": 3.5, "reasoning": "r"}',
        '{"score": "4", "reasoning": "r"}',
      ]) {
        expect(() => parseJudgeVerdict(raw)).toThrowError(/judge verdict/);
      }
    },
  );

  it(
    "フィールド欠落(score 無し / reasoning 無し)は throw する",
    {
      annotation: {
        type: "description",
        description:
          "score または reasoning を欠く JSON が 'judge verdict' 入りの Error になることを検証",
      },
    },
    () => {
      expect(() => parseJudgeVerdict('{"reasoning": "no score"}')).toThrowError(/judge verdict/);
      expect(() => parseJudgeVerdict('{"score": 4}')).toThrowError(/judge verdict/);
    },
  );
});

function passingChecks(): CheckResult[] {
  return [
    { name: "length", pass: true, detail: "" },
    { name: "must-mention", pass: true, detail: "" },
    { name: "must-not-mention", pass: true, detail: "" },
  ];
}

function makeResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: "case-1",
    draft: "Thanks for reaching out. Please try the reset link again.",
    checks: passingChecks(),
    verdict: { score: 5, reasoning: "ok" } satisfies JudgeVerdict,
    error: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it(
    "must-mention 欠落は judge>=4 なら soft で数えず、must-not-mention は judge 満点でも hard",
    {
      annotation: {
        type: "description",
        description:
          "must-mention のみ fail のケースは verdict.score>=4 なら programmaticFailures に数えず pass を維持し、must-not-mention の fail は score=5 でも hard として pass=false になることを検証(安全・リーク系の床は judge で緩めない)",
      },
    },
    () => {
      const softMiss = makeResult({
        id: "soft",
        checks: [
          { name: "length", pass: true, detail: "" },
          { name: "must-mention", pass: false, detail: "missing: reset" },
          { name: "must-not-mention", pass: true, detail: "" },
        ],
      });
      expect(summarize([softMiss])).toEqual({
        total: 1,
        programmaticFailures: 0,
        rubricPassRate: 1,
        pass: true,
      });

      const leak = makeResult({
        id: "leak",
        checks: [
          { name: "length", pass: true, detail: "" },
          { name: "must-mention", pass: true, detail: "" },
          { name: "must-not-mention", pass: false, detail: "found: you are a support agent" },
        ],
      });
      expect(summarize([leak]).programmaticFailures).toBe(1);
      expect(summarize([leak]).pass).toBe(false);
    },
  );

  it(
    "must-mention 欠落でも judge<4 または verdict 不在なら hard に数える",
    {
      annotation: {
        type: "description",
        description:
          "must-mention fail のケースが verdict.score=3 のとき、および verdict=null(judge 不通)のとき、いずれも programmaticFailures に数えられることを検証(soft 化の条件は judge による接地保証がある場合だけ)",
      },
    },
    () => {
      const missChecks = [
        { name: "length", pass: true, detail: "" },
        { name: "must-mention", pass: false, detail: "missing: reset" },
        { name: "must-not-mention", pass: true, detail: "" },
      ];
      const lowScore = makeResult({
        id: "low",
        checks: missChecks,
        verdict: { score: 3, reasoning: "vague" },
      });
      expect(summarize([lowScore]).programmaticFailures).toBe(1);

      const noVerdict = makeResult({ id: "nv", checks: missChecks, verdict: null });
      expect(summarize([noVerdict]).programmaticFailures).toBe(1);
    },
  );

  it(
    "全ケース緑なら pass=true(programmaticFailures=0, rubricPassRate=1)",
    {
      annotation: {
        type: "description",
        description:
          "全ケースが checks 合格・score>=4・error/verdict null 無しのとき Summary が pass=true になることを検証",
      },
    },
    () => {
      const summary = summarize([
        makeResult({ id: "a" }),
        makeResult({ id: "b", verdict: { score: 4, reasoning: "good" } }),
      ]);
      expect(summary).toEqual({
        total: 2,
        programmaticFailures: 0,
        rubricPassRate: 1,
        pass: true,
      });
    },
  );

  it(
    "programmaticFailures は fail チェックを含む「ケース数」で数え、1件でもあれば pass=false",
    {
      annotation: {
        type: "description",
        description:
          "1ケース内に複数の fail チェックがあっても programmaticFailures は 1 と数え、pass=false になることを検証",
      },
    },
    () => {
      const failing = makeResult({
        id: "a",
        checks: [
          { name: "length", pass: false, detail: "too short" },
          { name: "must-mention", pass: false, detail: "missing: reset" },
          { name: "must-not-mention", pass: true, detail: "" },
        ],
      });
      const summary = summarize([failing, makeResult({ id: "b" })]);
      expect(summary.programmaticFailures).toBe(1);
      expect(summary.pass).toBe(false);
    },
  );

  it(
    "rubricPassRate がちょうど 0.8 なら pass=true(score>=4 が合格)",
    {
      annotation: {
        type: "description",
        description:
          "5ケース中 score>=4 が4件(rubricPassRate=0.8 ちょうど)のとき閾値を満たし pass=true になることを検証(境界)",
      },
    },
    () => {
      const summary = summarize([
        makeResult({ id: "a", verdict: { score: 5, reasoning: "r" } }),
        makeResult({ id: "b", verdict: { score: 4, reasoning: "r" } }),
        makeResult({ id: "c", verdict: { score: 4, reasoning: "r" } }),
        makeResult({ id: "d", verdict: { score: 4, reasoning: "r" } }),
        makeResult({ id: "e", verdict: { score: 3, reasoning: "r" } }),
      ]);
      expect(summary.rubricPassRate).toBe(0.8);
      expect(summary.pass).toBe(true);
    },
  );

  it(
    "rubricPassRate が 0.8 未満なら pass=false",
    {
      annotation: {
        type: "description",
        description:
          "4ケース中 score>=4 が3件(rubricPassRate=0.75)のとき閾値割れで pass=false になることを検証",
      },
    },
    () => {
      const summary = summarize([
        makeResult({ id: "a" }),
        makeResult({ id: "b" }),
        makeResult({ id: "c" }),
        makeResult({ id: "d", verdict: { score: 3, reasoning: "r" } }),
      ]);
      expect(summary.rubricPassRate).toBe(0.75);
      expect(summary.pass).toBe(false);
    },
  );

  it(
    "error のあるケースが 1 件でもあれば pass=false(他が全緑でも)",
    {
      annotation: {
        type: "description",
        description:
          "生成失敗(error 記録・checks 空・verdict null)のケースが混ざると、他が全緑でも pass=false になることを検証",
      },
    },
    () => {
      const summary = summarize([
        makeResult({ id: "a" }),
        makeResult({ id: "b", draft: "", checks: [], verdict: null, error: "generation failed" }),
      ]);
      // The errored case has no verdict, so the rate is over the 1 non-null one.
      expect(summary.rubricPassRate).toBe(1);
      expect(summary.pass).toBe(false);
    },
  );

  it(
    "verdict が null のケース(judge 失敗)があれば pass=false",
    {
      annotation: {
        type: "description",
        description:
          "error は無いが verdict=null(judge 呼び出し失敗)のケースが混ざると pass=false になることを検証",
      },
    },
    () => {
      const summary = summarize([makeResult({ id: "a" }), makeResult({ id: "b", verdict: null })]);
      expect(summary.pass).toBe(false);
    },
  );

  it(
    "verdict 非 null が 0 件なら rubricPassRate は 0",
    {
      annotation: {
        type: "description",
        description:
          "全ケースの verdict が null のとき rubricPassRate が 0(ゼロ除算にならない)ことを検証",
      },
    },
    () => {
      const summary = summarize([
        makeResult({ id: "a", verdict: null }),
        makeResult({ id: "b", verdict: null }),
      ]);
      expect(summary.rubricPassRate).toBe(0);
      expect(summary.pass).toBe(false);
    },
  );
});
