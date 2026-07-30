// Shared types for the reply-draft eval harness (spec: specs/evals.md).

export type EvalCase = {
  id: string;
  ticket: { subject: string; status: string; priority: string; requesterEmail: string };
  messages: Array<{ authorRole: string; authorEmail: string; body: string }>;
  mustMention: string[];
  mustNotMention?: string[];
  minChars?: number;
  maxChars?: number;
};

export type CheckResult = { name: string; pass: boolean; detail: string };

// score is an integer 1..5 (rubric lives in judge.ts).
export type JudgeVerdict = { score: number; reasoning: string };

export type CaseResult = {
  id: string;
  draft: string;
  checks: CheckResult[];
  verdict: JudgeVerdict | null; // null when the judge call itself failed
  error: string | null; // generation failure reason; checks stay [] in that case
};

export type Summary = {
  total: number;
  programmaticFailures: number; // cases with at least one pass=false check
  rubricPassRate: number; // score >= 4 cases / cases with a verdict (0 when none)
  pass: boolean;
};
