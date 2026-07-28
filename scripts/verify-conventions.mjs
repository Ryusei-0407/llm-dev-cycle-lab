#!/usr/bin/env node
// Deterministic verification of the project-specific test conventions from
// docs/POLICY.md — the rules generic linters cannot check. Exit 1 on any
// violation. Wired into `pnpm check`, the pre-commit hook, and CI.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const violations = [];

function report(file, line, rule, detail) {
  violations.push(`${file}:${line}  [${rule}] ${detail}`);
}

function listFiles(dir, ext = /\.(ts|tsx)$/) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const e2eTestFiles = listFiles("e2e/tests");
const componentTestFiles = listFiles("e2e/components");
const browserTestFiles = listFiles("apps/web/test-browser");
const allSpecFiles = [...e2eTestFiles, ...componentTestFiles];

// Rule 1: no fixed waits — web-first assertions only.
for (const file of [...allSpecFiles, ...browserTestFiles, ...listFiles("e2e/helpers")]) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/waitForTimeout\s*\(/g)) {
    report(
      file,
      lineOf(source, match.index),
      "no-fixed-wait",
      "waitForTimeout は禁止(web-first assertion を使う)",
    );
  }
}

// Rule 2: no hardcoded connection info inside spec files (belongs in config/env).
for (const file of allSpecFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/https?:\/\/(localhost|127\.0\.0\.1)/g)) {
    report(
      file,
      lineOf(source, match.index),
      "no-connection-info",
      "接続先のハードコード禁止(config / 環境変数へ)",
    );
  }
}

// Rule 3: every describe must carry a @feature-<name> tag.
// Rule 4: mock-lane E2E per feature: at most 3 tests (happy 1 + failure 2).
//         @pinned (refutation-pinned), @backend, @component are exempt.
// Rule 5: files with a @smoke test must pin the final structure (aria snapshot).
// Rule 6: e2e/tests specs use test.step + snap (narrative traces + staged shots).
const featureCounts = new Map();
for (const file of allSpecFiles) {
  const source = readFileSync(file, "utf8");

  const describes = [...source.matchAll(/test\.describe\(\s*["'`]([^"'`]+)["'`]/g)];
  if (describes.length === 0) {
    report(file, 1, "structure", "test.describe が無い(タグは describe に付与する)");
    continue;
  }
  const describeTitle = describes.map((d) => d[1]).join(" ");
  const feature = describeTitle.match(/@feature-[\w-]+/)?.[0];
  if (!feature) {
    report(
      file,
      lineOf(source, describes[0].index),
      "feature-tag",
      "describe に @feature-<name> タグが必要",
    );
  }

  const isMockLane = !/@backend|@component/.test(describeTitle);
  const tests = [...source.matchAll(/^\s*test\(\s*["'`]([^"'`]+)["'`]/gm)];
  if (feature && isMockLane) {
    const counted = tests.filter((t) => !/@pinned/.test(t[1])).length;
    featureCounts.set(feature, {
      count: (featureCounts.get(feature)?.count ?? 0) + counted,
      file,
    });
  }

  if (/@smoke/.test(source) && !source.includes("toMatchAriaSnapshot")) {
    report(file, 1, "aria-snapshot", "@smoke テストの最終状態に toMatchAriaSnapshot が必要");
  }

  if (e2eTestFiles.includes(file)) {
    if (!source.includes("test.step(")) {
      report(file, 1, "test-step", "E2E はフェーズを test.step で構造化する");
    }
    if (!source.includes("snap(")) {
      report(file, 1, "staged-snap", "状態遷移ごとの snap()(段階スクショ)が必要");
    }
  }
}

for (const [feature, { count, file }] of featureCounts) {
  if (count > 3) {
    report(
      file,
      1,
      "e2e-budget",
      `${feature} のモックE2Eが ${count} 本(上限3: 正常1+失敗2)。超過分は機能分割か @pinned(反証固定)の根拠が必要`,
    );
  }
}

if (violations.length > 0) {
  console.error(`verify-conventions: ${violations.length} violation(s)\n`);
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("\nルールの定義: docs/POLICY.md(共通規約)");
  process.exit(1);
}
console.log(
  `verify-conventions: OK (${allSpecFiles.length + browserTestFiles.length} test files, ${featureCounts.size} feature(s))`,
);
