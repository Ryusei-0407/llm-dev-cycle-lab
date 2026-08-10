import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvals } from "../evals/run.js";
import type { EvalCase, JudgeVerdict } from "../evals/types.js";

// evals (spec: specs/evals.md) MUST 6 & 7: the orchestration exported from
// run.ts as runEvals(deps). The CLI wrapper stays thin (arg parsing, real
// generate/judge wiring, process.exit(summary.pass ? 0 : 1)), so the unit layer
// drives runEvals directly with injected fakes — no network, no real LLM.
//
// Injected contract (derived from the spec's seam requirement):
//   runEvals({ casesDir, outFile, generate, judge })
//     -> Promise<{ results: CaseResult[]; summary: Summary }>
//   generate: (evalCase) => Promise<string>  // full draft text (stream joined)
//   judge:    JudgeFn                        // (evalCase, draft) => JudgeVerdict
// The report file at outFile holds the same { results, summary } as JSON, and
// summary.pass is the value the CLI maps onto the exit code.

const createdDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two minimal cases; filenames are lexicographic so results come back
// [alpha, beta]. minChars is explicit and small so short fake drafts pass.
function writeCasesDir(): string {
  const dir = tempDir("evals-run-cases-");
  const base = {
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
    mustNotMention: ["you are a support agent"],
    minChars: 20,
    maxChars: 500,
  };
  writeFileSync(
    join(dir, "alpha.json"),
    JSON.stringify({ ...base, id: "alpha", mustMention: ["reset"] }),
  );
  writeFileSync(
    join(dir, "beta.json"),
    JSON.stringify({ ...base, id: "beta", mustMention: ["refund"] }),
  );
  return dir;
}

const DRAFTS: Record<string, string> = {
  alpha: "Thanks for reaching out. Please try the reset flow once more and tell us the result.",
  beta: "We have issued the refund to your original payment method. Thanks for your patience.",
};

function okGenerate(evalCase: EvalCase): Promise<string> {
  return Promise.resolve(DRAFTS[evalCase.id] ?? "unknown case");
}

function okJudge(): Promise<JudgeVerdict> {
  return Promise.resolve({ score: 5, reasoning: "faithful, responsive, polite" });
}

function outFileIn(dir: string): string {
  return join(dir, "evals-report.json");
}

describe("runEvals orchestration", () => {
  it(
    "注入した fake 生成/judge で全ケースが CaseResult 化され、report JSON が書かれる",
    {
      annotation: {
        type: "description",
        description:
          "fake の生成・judge を注入した runEvals が全ケースを CaseResult 化(checks 3件 + verdict)し、--out 相当のファイルに results + summary の JSON を書き、pass=true を返すことを検証",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      const outFile = outFileIn(tempDir("evals-run-out-"));
      const { results, summary } = await runEvals({
        casesDir,
        outFile,
        generate: okGenerate,
        judge: okJudge,
      });

      expect(results.map((r) => r.id)).toEqual(["alpha", "beta"]);
      for (const result of results) {
        expect(result.draft).toBe(DRAFTS[result.id]);
        expect(result.error).toBeNull();
        expect(result.checks.map((c) => c.name)).toEqual([
          "length",
          "must-mention",
          "must-not-mention",
        ]);
        expect(result.checks.every((c) => c.pass)).toBe(true);
        expect(result.verdict).toEqual({ score: 5, reasoning: "faithful, responsive, polite" });
      }
      expect(summary).toEqual({
        total: 2,
        programmaticFailures: 0,
        rubricPassRate: 1,
        pass: true,
      });

      const report = JSON.parse(readFileSync(outFile, "utf8"));
      expect(report.results.map((r: { id: string }) => r.id)).toEqual(["alpha", "beta"]);
      expect(report.summary.pass).toBe(true);
    },
  );

  it(
    "judge が閾値割れの score を返すと summary.pass=false(CLI の exit 1 に対応)",
    {
      annotation: {
        type: "description",
        description:
          "全ケースの judge score が 3 のとき rubricPassRate=0 で summary.pass=false になり、report にも fail が記録されることを検証(CLI は pass を exit code に写像)",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      const outFile = outFileIn(tempDir("evals-run-out-"));
      const { summary } = await runEvals({
        casesDir,
        outFile,
        generate: okGenerate,
        judge: () => Promise.resolve({ score: 3, reasoning: "not directly responsive" }),
      });
      expect(summary.rubricPassRate).toBe(0);
      expect(summary.pass).toBe(false);
      const report = JSON.parse(readFileSync(outFile, "utf8"));
      expect(report.summary.pass).toBe(false);
    },
  );

  it(
    "mustMention 欠落は judge>=4 なら soft(pass 維持)、judge<4 なら hard で pass=false",
    {
      annotation: {
        type: "description",
        description:
          "mustMention を満たさないドラフトでも judge score>=4 なら警告扱いで summary.pass=true(言い換えを FAIL にしない)、judge score<4 のときは従来どおり programmaticFailures に数えられ pass=false になることを検証",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      // Long enough for minChars but never contains "reset" / "refund".
      const vague = () => Promise.resolve("Thanks for contacting support. We will look into it.");

      const soft = await runEvals({
        casesDir,
        outFile: outFileIn(tempDir("evals-run-out-")),
        generate: vague,
        judge: okJudge, // score 5 — 接地は judge が保証
      });
      expect(soft.results.every((r) => r.checks.some((c) => !c.pass))).toBe(true);
      expect(soft.summary.programmaticFailures).toBe(0);
      // rubric は満点なので pass は維持される(soft ミスはゲート対象外)。
      expect(soft.summary.pass).toBe(true);

      const hard = await runEvals({
        casesDir,
        outFile: outFileIn(tempDir("evals-run-out-")),
        generate: vague,
        judge: () => Promise.resolve({ score: 3, reasoning: "not grounded" }),
      });
      expect(hard.summary.programmaticFailures).toBe(2);
      expect(hard.summary.pass).toBe(false);
    },
  );

  it(
    "生成 API エラーは 1 回リトライされ、2回目成功なら成功扱い",
    {
      annotation: {
        type: "description",
        description:
          "alpha の生成が1回目 reject・2回目 resolve のとき、リトライで CaseResult.error=null のまま成功し、生成呼び出しが2回で止まることを検証",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      const outFile = outFileIn(tempDir("evals-run-out-"));
      const calls: Record<string, number> = {};
      const flakyGenerate = (evalCase: EvalCase): Promise<string> => {
        calls[evalCase.id] = (calls[evalCase.id] ?? 0) + 1;
        if (evalCase.id === "alpha" && calls.alpha === 1) {
          return Promise.reject(new Error("503 upstream unavailable"));
        }
        return okGenerate(evalCase);
      };
      const { results, summary } = await runEvals({
        casesDir,
        outFile,
        generate: flakyGenerate,
        judge: okJudge,
      });
      expect(calls.alpha).toBe(2);
      expect(calls.beta).toBe(1);
      const alpha = results.find((r) => r.id === "alpha");
      expect(alpha?.error).toBeNull();
      expect(alpha?.draft).toBe(DRAFTS.alpha);
      expect(summary.pass).toBe(true);
    },
  );

  it(
    "生成が2連続で失敗したケースは CaseResult.error に理由が入り checks=[] / verdict=null",
    {
      annotation: {
        type: "description",
        description:
          "alpha の生成が2連続 reject のときリトライは1回で打ち切られ(呼び出し2回)、error に理由・checks 空・verdict null で記録され summary.pass=false になることを検証",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      const outFile = outFileIn(tempDir("evals-run-out-"));
      const calls: Record<string, number> = {};
      const failingGenerate = (evalCase: EvalCase): Promise<string> => {
        calls[evalCase.id] = (calls[evalCase.id] ?? 0) + 1;
        if (evalCase.id === "alpha") {
          return Promise.reject(new Error("quota exhausted"));
        }
        return okGenerate(evalCase);
      };
      const { results, summary } = await runEvals({
        casesDir,
        outFile,
        generate: failingGenerate,
        judge: okJudge,
      });
      expect(calls.alpha).toBe(2); // initial attempt + exactly one retry
      const alpha = results.find((r) => r.id === "alpha");
      expect(alpha?.error).toContain("quota exhausted");
      expect(alpha?.checks).toEqual([]);
      expect(alpha?.verdict).toBeNull();
      // The healthy case still completes independently.
      const beta = results.find((r) => r.id === "beta");
      expect(beta?.error).toBeNull();
      expect(summary.pass).toBe(false);
    },
  );

  it(
    "judge 呼び出しが失敗したケースは verdict=null(error は生成失敗専用)で pass=false",
    {
      annotation: {
        type: "description",
        description:
          "生成は成功したが judge が reject するとき CaseResult は verdict=null・error=null・checks あり、summary.pass=false になることを検証",
      },
    },
    async () => {
      const casesDir = writeCasesDir();
      const outFile = outFileIn(tempDir("evals-run-out-"));
      const { results, summary } = await runEvals({
        casesDir,
        outFile,
        generate: okGenerate,
        judge: () => Promise.reject(new Error("judge unavailable")),
      });
      for (const result of results) {
        expect(result.verdict).toBeNull();
        expect(result.error).toBeNull();
        expect(result.checks.length).toBe(3);
      }
      expect(summary.pass).toBe(false);
    },
  );
});

// nightly 実運用(run 30586317134)の反例固定: Gemini 無料枠の 429 は
// RetryInfo(retryDelay)で再試行猶予を返すが、即時リトライは同じレート窓を
// 踏んで二連敗した。onceRetried は猶予を読み取って待ってから再試行する。
describe("runEvals 429 retry pinned counterexamples", () => {
  const RATE_LIMIT_MESSAGE =
    '{\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota. Please retry in 38.955063224s.",\n    "status": "RESOURCE_EXHAUSTED",\n    "details": [ { "retryDelay": "38s" } ]\n  }\n}';

  function failingOnceGenerate(message: string): {
    generate: (evalCase: EvalCase) => Promise<string>;
    calls: () => number;
  } {
    let calls = 0;
    return {
      generate: (evalCase) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error(message));
        return Promise.resolve(DRAFTS[evalCase.id] ?? "unknown case");
      },
      calls: () => calls,
    };
  }

  it("429(retryDelay あり)は猶予を待ってからリトライして成功する", async () => {
    const casesDir = writeCasesDir();
    const slept: number[] = [];
    const failing = failingOnceGenerate(RATE_LIMIT_MESSAGE);
    const { summary } = await runEvals({
      casesDir,
      outFile: outFileIn(tempDir("evals-run-out-")),
      generate: failing.generate,
      judge: okJudge,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    // retryDelay "38s" → 38000ms を1回だけ待つ(alpha の1敗のみ)。
    expect(slept).toEqual([38000]);
    expect(summary.pass).toBe(true);
  });

  it("待機は 60 秒で頭打ちにする(retryDelay 300s)", async () => {
    const casesDir = writeCasesDir();
    const slept: number[] = [];
    const failing = failingOnceGenerate('429 RESOURCE_EXHAUSTED { "retryDelay": "300s" }');
    await runEvals({
      casesDir,
      outFile: outFileIn(tempDir("evals-run-out-")),
      generate: failing.generate,
      judge: okJudge,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([60000]);
  });

  it("レート制限でないエラーは従来どおり即時リトライ(sleep 呼ばれず)", async () => {
    const casesDir = writeCasesDir();
    const slept: number[] = [];
    const failing = failingOnceGenerate("connection reset");
    const { summary } = await runEvals({
      casesDir,
      outFile: outFileIn(tempDir("evals-run-out-")),
      generate: failing.generate,
      judge: okJudge,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([]);
    expect(summary.pass).toBe(true);
  });
});
