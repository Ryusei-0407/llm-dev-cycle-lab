import type { CaseResult, CheckResult, EvalCase, JudgeVerdict, Summary } from "./types.js";

const DEFAULT_MIN_CHARS = 80;
const DEFAULT_MAX_CHARS = 1600;

// Deterministic checks over the generated draft. The check names and their
// order are part of the public contract (spec: specs/evals.md).
export function runProgrammaticChecks(draft: string, evalCase: EvalCase): CheckResult[] {
  const minChars = evalCase.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = evalCase.maxChars ?? DEFAULT_MAX_CHARS;
  const lower = draft.toLowerCase();

  const lengthPass = draft.length >= minChars && draft.length <= maxChars;
  const missing = evalCase.mustMention.filter((term) => !lower.includes(term.toLowerCase()));
  const detected = (evalCase.mustNotMention ?? []).filter((term) =>
    lower.includes(term.toLowerCase()),
  );

  return [
    {
      name: "length",
      pass: lengthPass,
      detail: `${draft.length} chars (min ${minChars}, max ${maxChars})`,
    },
    {
      name: "must-mention",
      pass: missing.length === 0,
      detail: missing.length === 0 ? "all terms present" : `missing: ${missing.join(", ")}`,
    },
    {
      name: "must-not-mention",
      pass: detected.length === 0,
      detail: detected.length === 0 ? "no forbidden terms" : `found: ${detected.join(", ")}`,
    },
  ];
}

// Parses the judge response text. Every failure message contains
// "judge verdict" so a red nightly log is greppable to this stage.
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`judge verdict is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof json !== "object" || json === null) {
    throw new Error("judge verdict must be a JSON object");
  }
  const { score, reasoning } = json as Record<string, unknown>;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error("judge verdict score must be an integer between 1 and 5");
  }
  if (typeof reasoning !== "string") {
    throw new Error("judge verdict reasoning must be a string");
  }
  return { score, reasoning };
}

// must-mention の欠落だけは judge が接地を高評価(score >= 4)している限り
// 警告(soft)にとどめる: 自由文への部分文字列一致は「モデルがその語で書く
// はず」という期待でしかなく、正当な言い換えを3度 nightly の FAIL にした
// (copilot-unassigned / credential-safety / password-reset)。安全・リーク系の
// must-not-mention と length、judge 不合格・不在時の must-mention は従来どおり
// hard(ゲート対象)のまま。
export function isHardCheckFailure(check: CheckResult, verdict: JudgeVerdict | null): boolean {
  if (check.name !== "must-mention") return true;
  return verdict === null || verdict.score < 4;
}

export function summarize(results: CaseResult[]): Summary {
  const total = results.length;
  const programmaticFailures = results.filter((r) =>
    r.checks.some((c) => !c.pass && isHardCheckFailure(c, r.verdict)),
  ).length;
  const judged = results.filter((r) => r.verdict !== null);
  const rubricPassRate =
    judged.length === 0
      ? 0
      : judged.filter((r) => (r.verdict as JudgeVerdict).score >= 4).length / judged.length;
  const pass =
    programmaticFailures === 0 &&
    rubricPassRate >= 0.8 &&
    results.every((r) => r.error === null) &&
    results.every((r) => r.verdict !== null);
  return { total, programmaticFailures, rubricPassRate, pass };
}
