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
  mustMention: z.array(z.string()),
  mustNotMention: z.array(z.string()).optional(),
  minChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

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
    const raw = readFileSync(path.join(dir, file), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`evals case ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`evals case ${file}: ${parsed.error.message}`);
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`evals case ${file}: duplicate id "${parsed.data.id}"`);
    }
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}
