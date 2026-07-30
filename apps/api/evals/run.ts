import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { buildDraftMessages, buildDraftSystemPrompt } from "../src/tickets/draft.js";
import { loadCases } from "./cases.js";
import { buildJudgePrompt, type JudgeFn, realJudge } from "./judge.js";
import { runProgrammaticChecks, summarize } from "./scoring.js";
import type { CaseResult, EvalCase, Summary } from "./types.js";

export type GenerateFn = (evalCase: EvalCase) => Promise<string>;

export type RunEvalsDeps = {
  casesDir: string;
  outFile: string;
  generate: GenerateFn;
  judge: JudgeFn;
  log?: (line: string) => void;
};

// One retry on API errors only. Quality failures are never retried — variance
// belongs to the thresholds, not to reruns (spec: specs/evals.md 方針).
async function onceRetried<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function draftPreview(result: CaseResult): string {
  const text = result.draft.replace(/\s+/g, " ").trim().slice(0, 80);
  return text !== "" ? text : (result.error ?? "");
}

export function renderMarkdown(results: CaseResult[], summary: Summary): string {
  const rows = results.map((r) => {
    const checks =
      r.error !== null ? "error" : `${r.checks.filter((c) => c.pass).length}/${r.checks.length}`;
    const score = r.verdict !== null ? String(r.verdict.score) : "-";
    return `| ${r.id} | ${checks} | ${score} | ${draftPreview(r)} |`;
  });
  return [
    "## reply-draft evals",
    "",
    "| id | checks | score | draft (first 80 chars) |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `total: ${summary.total} | programmatic failures: ${summary.programmaticFailures} | rubric pass rate: ${summary.rubricPassRate.toFixed(2)} | ${summary.pass ? "PASS" : "FAIL"}`,
  ].join("\n");
}

// Orchestration seam: everything network-shaped (generate / judge) arrives via
// deps so unit tests drive the whole flow without touching the network.
export async function runEvals(
  deps: RunEvalsDeps,
): Promise<{ results: CaseResult[]; summary: Summary }> {
  const log = deps.log ?? console.log;
  const cases = loadCases(deps.casesDir);
  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    let draft: string;
    try {
      draft = await onceRetried(() => deps.generate(evalCase));
    } catch (err) {
      results.push({
        id: evalCase.id,
        draft: "",
        checks: [],
        verdict: null,
        error: errorMessage(err),
      });
      continue;
    }

    const checks = runProgrammaticChecks(draft, evalCase);
    let verdict: CaseResult["verdict"];
    try {
      verdict = await onceRetried(() => deps.judge(evalCase, draft));
    } catch {
      verdict = null; // judge failure is a verdict gap, not a generation error
    }
    results.push({ id: evalCase.id, draft, checks, verdict, error: null });
  }

  const summary = summarize(results);
  writeFileSync(deps.outFile, JSON.stringify({ results, summary }, null, 2));
  log(renderMarkdown(results, summary));
  return { results, summary };
}

// Real generation: the production prompt path (buildDraftSystemPrompt +
// buildDraftMessages) against the production model, streamed and concatenated.
export function realGenerate(client: GoogleGenAI, model: string): GenerateFn {
  return async (evalCase) => {
    const [message] = buildDraftMessages(evalCase.ticket, evalCase.messages);
    const stream = await client.models.generateContentStream({
      model,
      contents: [{ role: "user", parts: [{ text: message.content }] }],
      config: { systemInstruction: buildDraftSystemPrompt() },
    });
    let draft = "";
    for await (const chunk of stream) {
      draft += chunk.text ?? "";
    }
    return draft;
  };
}

// --- thin CLI wrapper ------------------------------------------------------
// Usage: tsx evals/run.ts [--cases=<dir>] [--out=<file>] [--dry-run]

const evalsDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { casesDir: string; outFile: string; dryRun: boolean } {
  let casesDir = path.join(evalsDir, "cases");
  let outFile = path.resolve(evalsDir, "..", "evals-report.json");
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--cases=")) casesDir = path.resolve(arg.slice("--cases=".length));
    else if (arg.startsWith("--out=")) outFile = path.resolve(arg.slice("--out=".length));
  }
  return { casesDir, outFile, dryRun };
}

async function main(): Promise<number> {
  const { casesDir, outFile, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    // Wiring check only: load cases and assemble every prompt, no LLM calls.
    const cases = loadCases(casesDir);
    for (const evalCase of cases) {
      buildDraftSystemPrompt();
      buildDraftMessages(evalCase.ticket, evalCase.messages);
      buildJudgePrompt(evalCase, "dry-run draft");
    }
    console.log(`dry-run ok (${cases.length} cases)`);
    return 0;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is required");
    return 2;
  }

  // gemini-flash-latest は常に現行世代を指すエイリアス(既存 llm/gemini.ts と同じ既定)
  const model = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
  const client = new GoogleGenAI({ apiKey });
  const { summary } = await runEvals({
    casesDir,
    outFile,
    generate: realGenerate(client, model),
    judge: realJudge(client, model),
  });
  return summary.pass ? 0 : 1;
}

// Run only when invoked as a script (tsx evals/run.ts) — importing runEvals
// from a test must not trigger the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
