import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EvalCase } from "./types.js";

const evalCaseSchema = z.object({
  id: z.string().min(1),
  ticket: z.object({
    subject: z.string(),
    status: z.string(),
    priority: z.string(),
    requesterEmail: z.string(),
  }),
  messages: z
    .array(z.object({ authorRole: z.string(), authorEmail: z.string(), body: z.string() }))
    .min(1),
  // 空文字列語は includes("") が常に true になり、チェックを無効化する
  // フットガンなので schema で弾く(敵対的レビューの指摘を固定)。
  mustMention: z.array(z.string().min(1)),
  mustNotMention: z.array(z.string().min(1)).optional(),
  minChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

// minChars > maxChars は length チェックが永久に fail する設定ミス。既定値
// (80/1600)との組み合わせでも成立し得るため、解決後の値で検証する。
const boundsValid = (c: z.infer<typeof evalCaseSchema>) =>
  (c.minChars ?? 80) <= (c.maxChars ?? 1600);

// Reads *.json from dir in lexicographic order so the report ordering is stable
// across filesystems. Every failure names the offending file — a broken case
// must point at itself, not at the harness.
export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const seen = new Set<string>();
  const cases: EvalCase[] = [];
  for (const file of files) {
    let json: unknown;
    try {
      // readFileSync も try 内に置く: *.json 名のディレクトリや読取不可ファイル
      // でも「どのケースが壊れているか」をファイル名で指せるようにする。
      json = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      throw new Error(`evals case ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`evals case ${file}: ${parsed.error.message}`);
    }
    if (!boundsValid(parsed.data)) {
      throw new Error(`evals case ${file}: minChars must be <= maxChars`);
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`evals case ${file}: duplicate id "${parsed.data.id}"`);
    }
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}
