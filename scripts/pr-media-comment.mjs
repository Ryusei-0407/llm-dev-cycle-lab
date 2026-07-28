#!/usr/bin/env node
// Posts (or updates) a PR comment with per-test screenshots and screen
// recordings from a Playwright run.
//
// GitHub has no API to upload attachments to comments, so media is committed
// to a dedicated `ci-media` branch of this repo and embedded via same-repo
// blob URLs with ?raw=true — GitHub rewrites those to short-lived signed URLs
// at render time, so they display inline even on private repos (the approach
// reg-viz/reg-actions uses). Videos are converted to GIF (comments cannot
// embed video URLs).
//
// Usage:
//   node scripts/pr-media-comment.mjs             # CI: convert, push, comment
//   node scripts/pr-media-comment.mjs --dry-run   # local: convert + print markdown
//
// Env (CI mode): GH_TOKEN, PR_NUMBER, GITHUB_REPOSITORY, GITHUB_RUN_ID
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const RESULTS = "e2e/results.json";
const MEDIA_BRANCH = "ci-media";
const KEEP_RUNS_PER_PR = 3;
const MARKER = "<!-- pr-media-comment -->";

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ---- 1. Collect tests + attachments from the Playwright JSON report ----
if (!existsSync(RESULTS)) {
  console.error(`${RESULTS} not found — run the e2e suite with the json reporter first.`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(RESULTS, "utf8"));
const tests = [];
function walkSuite(suite, crumbs) {
  for (const child of suite.suites ?? []) walkSuite(child, [...crumbs, child.title]);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.at(-1); // last retry wins
      if (!result) continue;
      tests.push({
        title: [...crumbs, spec.title].filter(Boolean).join(" › "),
        status: test.status ?? result.status,
        durationMs: result.duration ?? 0,
        attachments: (result.attachments ?? []).filter((a) => a.path),
      });
    }
  }
}
for (const suite of report.suites ?? []) walkSuite(suite, [suite.title]);

// ---- 2. Convert media (video -> gif, copy screenshots) ----
const outDir = "e2e/media-out";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Prefers system ffmpeg (devenv provides it locally), falling back to the
// binary shipped in @ffmpeg-installer/ffmpeg — network-independent in CI,
// unlike apt (observed a 22-minute mirror stall). Playwright's bundled
// ffmpeg is no substitute: it is a minimal build without a GIF encoder.
let ffmpeg = "ffmpeg";
try {
  sh(ffmpeg, ["-version"]);
} catch {
  try {
    ffmpeg = (await import("@ffmpeg-installer/ffmpeg")).default.path;
    sh(ffmpeg, ["-version"]);
  } catch {
    ffmpeg = null;
    console.error("ffmpeg not found — recordings will be skipped.");
  }
}

for (const test of tests) {
  const dir = path.join(outDir, slug(test.title));
  test.media = { screenshots: [], gifs: [] };
  // Staged snaps (helpers/snap.ts) in order, plus the automatic
  // failure screenshot when present.
  const screenshots = test.attachments.filter(
    (a) => a.name === "screenshot" || a.name.startsWith("stage: "),
  );
  const videos = test.attachments.filter((a) => a.name === "video");
  if (screenshots.length === 0 && videos.length === 0) continue;
  mkdirSync(dir, { recursive: true });
  screenshots.forEach((a, i) => {
    const file = path.join(dir, `screenshot-${i + 1}${path.extname(a.path) || ".png"}`);
    cpSync(a.path, file);
    test.media.screenshots.push({
      file,
      label: a.name.startsWith("stage: ") ? a.name.slice("stage: ".length) : "失敗時点(自動撮影)",
    });
  });
  if (ffmpeg) {
    videos.forEach((a, i) => {
      const file = path.join(dir, `recording-${i + 1}.gif`);
      try {
        sh(ffmpeg, [
          "-y",
          "-i",
          a.path,
          "-vf",
          "fps=10,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          file,
        ]);
        test.media.gifs.push(file);
      } catch (e) {
        console.error(`gif conversion failed for ${a.path}: ${e.message}`);
      }
    });
  }
}

// ---- 3. Publish media to the ci-media branch ----
const repo = process.env.GITHUB_REPOSITORY ?? "";
const prNumber = process.env.PR_NUMBER ?? "0";
const runId = process.env.GITHUB_RUN_ID ?? "local";
const destPrefix = `pr-${prNumber}/run-${runId}`;

function publishMedia() {
  const work = ".media-branch";
  rmSync(work, { recursive: true, force: true });
  const remote = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`;
  mkdirSync(work);
  sh("git", ["init", "-q", "-b", MEDIA_BRANCH], { cwd: work });
  sh("git", ["remote", "add", "origin", remote], { cwd: work });
  try {
    sh("git", ["fetch", "-q", "--depth", "1", "origin", MEDIA_BRANCH], { cwd: work });
    sh("git", ["reset", "-q", "--hard", `origin/${MEDIA_BRANCH}`], { cwd: work });
  } catch {
    /* branch does not exist yet — first publish */
  }
  // Prune old runs for this PR so the branch does not grow unbounded.
  const prDir = path.join(work, `pr-${prNumber}`);
  if (existsSync(prDir)) {
    const runs = readdirSync(prDir).sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - (KEEP_RUNS_PER_PR - 1)))) {
      rmSync(path.join(prDir, old), { recursive: true, force: true });
    }
  }
  cpSync(outDir, path.join(work, destPrefix), { recursive: true });
  sh("git", ["add", "-A"], { cwd: work });
  sh(
    "git",
    [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-q",
      "-m",
      `media for PR #${prNumber} run ${runId}`,
    ],
    { cwd: work },
  );
  sh("git", ["push", "-q", "origin", MEDIA_BRANCH], { cwd: work });
  rmSync(work, { recursive: true, force: true });
}

// ---- 4. Build the comment ----
function buildComment() {
  // Same-repo blob URLs with ?raw=true render inline even on private repos:
  // GitHub rewrites them to short-lived signed URLs for authorized viewers.
  const blobBase = `https://github.com/${repo}/blob/${MEDIA_BRANCH}`;
  const toRepoPath = (file) => `${destPrefix}/${path.relative(outDir, file)}`;
  const icon = {
    passed: "✅",
    expected: "✅",
    failed: "❌",
    unexpected: "❌",
    flaky: "⚠️",
    skipped: "⏭️",
  };
  const isFailure = (t) => t.status === "failed" || t.status === "unexpected";

  const failed = tests.filter(isFailure).length;
  const flaky = tests.filter((t) => t.status === "flaky").length;
  const passed = tests.length - failed - flaky;
  const totalSec = (tests.reduce((sum, t) => sum + t.durationMs, 0) / 1000).toFixed(1);

  let md = `${MARKER}\n## 🎬 E2E 実行証跡(録画・画面遷移)\n\n`;
  md += `**✅ ${passed} 成功**`;
  if (failed) md += ` · **❌ ${failed} 失敗**`;
  if (flaky) md += ` · **⚠️ ${flaky} flaky**`;
  md += ` · 合計 ${totalSec}s`;
  md += ` · [CI run](https://github.com/${repo}/actions/runs/${runId})\n\n`;
  md += `各テストを開くと、実行全体の録画と、操作段階ごとのスクリーンショットが見られます。\n\n`;

  // 失敗したテストを先頭に(証跡が最も必要なものから)
  const ordered = [...tests].sort((a, b) => Number(isFailure(b)) - Number(isFailure(a)));
  for (const test of ordered) {
    const media = test.media ?? { screenshots: [], gifs: [] };
    // Bare @tags in the title would be auto-linked as GitHub user mentions;
    // strip them from the title and show them as code spans instead.
    const tags = [...new Set(test.title.match(/@[\w-]+/g) ?? [])];
    const cleanTitle = test.title.replace(/\s*@[\w-]+/g, "").trim();
    const tagBadges = tags.map((t) => `<code>${t}</code>`).join(" ");
    md += `<details${isFailure(test) ? " open" : ""}><summary>${icon[test.status] ?? "❔"} <b>${cleanTitle}</b> ${tagBadges} <em>(${(test.durationMs / 1000).toFixed(1)}s)</em></summary>\n\n`;
    if (media.screenshots.length === 0 && media.gifs.length === 0) {
      md += `_このテストのメディアはありません_\n`;
    }
    for (const file of media.gifs) {
      md += `#### 📹 実行の録画\n\n![録画](${blobBase}/${toRepoPath(file)}?raw=true)\n\n`;
    }
    if (media.screenshots.length > 0) {
      md += `#### 🖼️ 画面の遷移(操作順)\n\n`;
      media.screenshots.forEach(({ file, label }, i) => {
        md += `**Step ${i + 1}: ${label}**\n\n![${label}](${blobBase}/${toRepoPath(file)}?raw=true)\n\n`;
      });
    }
    md += `</details>\n\n`;
  }
  md += `<sub>画像の保存先: [\`${MEDIA_BRANCH}\` ブランチ](${blobBase}/${destPrefix})(PRごとに直近${KEEP_RUNS_PER_PR}run分を保持) · run [${runId}](https://github.com/${repo}/actions/runs/${runId})</sub>\n`;
  return md;
}

function upsertComment(body) {
  const comments = JSON.parse(
    sh("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate"]),
  );
  const existing = comments.find((c) => c.body?.startsWith(MARKER));
  writeFileSync(".media-comment.md", body);
  if (existing) {
    sh("gh", [
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-F",
      "body=@.media-comment.md",
    ]);
  } else {
    sh("gh", [
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${prNumber}/comments`,
      "-F",
      "body=@.media-comment.md",
    ]);
  }
  rmSync(".media-comment.md", { force: true });
}

if (DRY_RUN) {
  console.log(buildComment());
  console.log(`\n--- dry run: media prepared under ${outDir}, nothing pushed/posted ---`);
} else {
  if (!repo || !process.env.GH_TOKEN || prNumber === "0") {
    console.error("GH_TOKEN / PR_NUMBER / GITHUB_REPOSITORY are required outside --dry-run.");
    process.exit(1);
  }
  const hasMedia = tests.some(
    (t) => (t.media?.screenshots.length ?? 0) + (t.media?.gifs.length ?? 0) > 0,
  );
  if (hasMedia) publishMedia();
  upsertComment(buildComment());
  console.log(`comment upserted on PR #${prNumber} (${tests.length} tests).`);
}
