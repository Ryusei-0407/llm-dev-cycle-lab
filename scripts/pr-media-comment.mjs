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
// Media is scoped to the PR: only tests whose feature was actually touched by
// the PR (per e2e/feature-map.json) — or that failed — get full media. The
// rest are listed by name in a single collapsed summary. This keeps the comment
// focused on the change under review instead of re-attaching the whole suite.
//
// Usage:
//   node scripts/pr-media-comment.mjs             # CI: convert, push, comment
//   node scripts/pr-media-comment.mjs --dry-run   # local: convert + print markdown
//   node scripts/pr-media-comment.mjs --dry-run --changed-files=a.ts,b.ts
//                                                 # local: inject the changed set
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
const FEATURE_MAP = "e2e/feature-map.json";
const E2E_TEST_DIR = "e2e/tests";
const MEDIA_BRANCH = "ci-media";
const KEEP_RUNS_PER_PR = 3;
const MARKER = "<!-- pr-media-comment -->";

// --changed-files=a.ts,b.ts injects the PR's changed set in dry-run so the
// scoping can be exercised locally without hitting the GitHub API.
const changedFilesArg = process.argv
  .find((a) => a.startsWith("--changed-files="))
  ?.slice("--changed-files=".length);

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
// spec.file is relative to the Playwright testDir (e2e/tests), e.g.
// "auth.spec.ts" or "../components/slow-hint.spec.ts". Resolve to a
// repo-relative path so it can be matched against the PR's changed files.
const specFileToRepoPath = (file) =>
  path.normalize(path.join(E2E_TEST_DIR, file)).replaceAll(path.sep, "/");
function walkSuite(suite, crumbs) {
  for (const child of suite.suites ?? []) walkSuite(child, [...crumbs, child.title]);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.at(-1); // last retry wins
      if (!result) continue;
      const description = (test.annotations ?? []).find(
        (a) => a.type === "description",
      )?.description;
      tests.push({
        title: [...crumbs, spec.title].filter(Boolean).join(" › "),
        fileTitle: crumbs[0],
        describePath: crumbs.slice(1).filter(Boolean).join(" › "),
        leaf: spec.title,
        status: test.status ?? result.status,
        durationMs: result.duration ?? 0,
        attachments: (result.attachments ?? []).filter((a) => a.path),
        error: result.errors?.[0]?.message ?? result.error?.message ?? null,
        description,
        specFile: spec.file ? specFileToRepoPath(spec.file) : undefined,
      });
    }
  }
}
for (const suite of report.suites ?? []) walkSuite(suite, [suite.title]);

// ---- 2. Scope each test to the PR: which features did the PR actually touch? ----
// Computed before media conversion so unrelated passing tests skip gif encoding
// entirely (they are only listed by name) and never reach the ci-media branch.
const repo = process.env.GITHUB_REPOSITORY ?? "";
const prNumber = process.env.PR_NUMBER ?? "0";
const runId = process.env.GITHUB_RUN_ID ?? "local";
const destPrefix = `pr-${prNumber}/run-${runId}`;

// Minimatch-free glob → regex, supporting only the two constructs the
// feature-map uses: `**` (any path depth, including none) and `*` (any run of
// non-slash chars). Keeps the dependency footprint at zero (POLICY §6).
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `**/` — any number of leading path segments (including none).
          i++;
          re += "(?:.*/)?";
        } else {
          // trailing `**` — any suffix, spanning path separators.
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`${re}$`);
}

const featureMap = existsSync(FEATURE_MAP) ? JSON.parse(readFileSync(FEATURE_MAP, "utf8")) : {};
const featureMatchers = new Map(
  Object.entries(featureMap).map(([name, globs]) => [name, globs.map(globToRegExp)]),
);

// Returns the PR's changed files with their git status, or null when the set is
// unknown (dry-run without injection). Dry-run injection accepts "path" (treated
// as modified) or "path:added" to exercise the new-vs-existing split.
function getChangedEntries() {
  if (changedFilesArg !== undefined) {
    return changedFilesArg
      .split(",")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => {
        const [filename, status] = raw.split(":");
        return { filename: filename.trim(), status: (status ?? "modified").trim() };
      });
  }
  if (DRY_RUN) return null;
  // {filename,status} per line — safe across --paginate pages, and avoids the
  // multi-line `patch` field that would break line-based parsing.
  return sh("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/files`,
    "--paginate",
    "--jq",
    ".[] | {filename, status} | @json",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const changedEntries = getChangedEntries();
const changedFiles = changedEntries?.map((e) => e.filename) ?? null;
// Spec files added (not modified) in this PR — their tests are new implementations.
const addedFiles = new Set(
  (changedEntries ?? []).filter((e) => e.status === "added").map((e) => e.filename),
);
// null = we could not determine the changed set (dry-run without injection).
// Then scoping cannot apply, so every test is treated as related (old behavior).
const scopingActive = changedFiles !== null;

// A test's feature is the @feature-<name> tag in its title.
function featureOf(test) {
  return test.title.match(/@feature-([\w-]+)/)?.[1];
}

// Returns why a test is in scope for this PR: the trigger and the changed
// file(s) behind it, so shared-file matches (e.g. a schema/entry-point edit
// pulling in an unrelated feature) are transparent rather than mysterious.
function relationOf(test) {
  if (!scopingActive) return { related: true, reason: null, files: [] };
  if (test.status === "failed" || test.status === "unexpected") {
    return { related: true, reason: "失敗", files: [] };
  }
  if (test.specFile && changedFiles.includes(test.specFile)) {
    const added = addedFiles.has(test.specFile);
    return {
      related: true,
      reason: added ? "新規追加" : "テスト自体を変更",
      files: [test.specFile],
    };
  }
  const feature = featureOf(test);
  if (!feature) return { related: false, reason: null, files: [] };
  if (changedFiles.includes(`specs/${feature}.md`)) {
    return { related: true, reason: "仕様書を変更", files: [`specs/${feature}.md`] };
  }
  const matchers = featureMatchers.get(feature) ?? [];
  const files = changedFiles.filter((f) => matchers.some((re) => re.test(f)));
  return files.length > 0
    ? { related: true, reason: "関連ファイルを変更", files }
    : { related: false, reason: null, files: [] };
}

for (const test of tests) {
  const rel = relationOf(test);
  test.related = rel.related;
  test.relationReason = rel.reason;
  test.relationFiles = rel.files;
  // New = the test's spec file was added in this PR (the common shape of a new
  // feature: a fresh spec file). Tests added into an existing file fall under
  // "existing (related)" — acceptable, the file is already shown.
  test.isNew = Boolean(test.specFile && addedFiles.has(test.specFile));
}
// Unrelated passing (non-flaky) tests are listed by name only — no media.
const wantsMedia = (test) =>
  test.related ||
  test.status === "failed" ||
  test.status === "unexpected" ||
  test.status === "flaky";

// ---- 3. Convert media (video -> gif, copy screenshots) ----
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
  test.media = { screenshots: [], gifs: [] };
  // Unrelated passing tests are listed by name only, so skip their (expensive)
  // gif conversion and keep them off the ci-media branch.
  if (!wantsMedia(test)) continue;
  const dir = path.join(outDir, slug(test.title));
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
          // setpts=2.0 で再生速度を 0.5 倍に(テスト実行は等速のまま、閲覧だけスロー)
          "setpts=2.0*PTS,fps=10,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          file,
        ]);
        test.media.gifs.push(file);
      } catch (e) {
        console.error(`gif conversion failed for ${a.path}: ${e.message}`);
      }
    });
  }
}

// ---- 4. Publish media to the ci-media branch ----
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

// ---- 5. Build the comment ----
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
  // Bare @tags in the title would be auto-linked as GitHub user mentions.
  const cleanTitleOf = (t) => t.title.replace(/\s*@[\w-]+/g, "").trim();

  const failed = tests.filter(isFailure).length;
  const flaky = tests.filter((t) => t.status === "flaky").length;
  const passed = tests.length - failed - flaky;
  const totalSec = (tests.reduce((sum, t) => sum + t.durationMs, 0) / 1000).toFixed(1);

  // Unrelated passing tests are collapsed into a single list; everything else
  // (related, plus any failure regardless of scope) gets its own full entry.
  // wantsMedia is the same predicate that gated media conversion above.
  const detailed = tests.filter(wantsMedia);
  const collapsed = tests.filter((t) => !wantsMedia(t));

  let md = `${MARKER}\n## 🎬 E2E 実行証跡(録画・画面遷移)\n\n`;
  md += `**✅ ${passed} 成功**`;
  if (failed) md += ` · **❌ ${failed} 失敗**`;
  if (flaky) md += ` · **⚠️ ${flaky} flaky**`;
  md += ` · 合計 ${totalSec}s`;
  md += ` · [CI run](https://github.com/${repo}/actions/runs/${runId})\n\n`;
  if (failed > 0) {
    md += `> [!CAUTION]\n> ❌ **${failed}本のテストが失敗しています。** 下の「失敗」セクションにエラー内容と証跡があります。\n\n`;
  } else {
    md += `> [!TIP]\n> ✅ すべてのテストが成功しています。\n\n`;
  }
  if (scopingActive) {
    md += `各テストを開くと、実行全体の録画と、操作段階ごとのスクリーンショットが見られます。`;
    md += `**メディアは変更関連のテストのみ表示**(失敗は関連に関わらず全表示)。`;
    md += `共有ファイル(APIのエントリやスキーマ等)を変更すると、それを参照する他機能も\`🔍 関連理由\`付きで表示されます。\n\n`;
  } else {
    md += `各テストを開くと、実行全体の録画と、操作段階ごとのスクリーンショットが見られます。\n\n`;
  }

  // ファイル → describe → テスト のツリー表示。失敗セクションを成功と分離して先頭に。
  const stripTags = (text) => text.replace(/\s*@[\w-]+/g, "").trim();
  const displayFile = (text) => text.replace(/^(\.\.\/)+/, "");
  const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
  const renderTree = (subset) => {
    const fileOrder = [];
    const byFile = new Map();
    for (const test of subset) {
      const key = test.fileTitle ?? "(unknown)";
      if (!byFile.has(key)) {
        byFile.set(key, []);
        fileOrder.push(key);
      }
      byFile.get(key).push(test);
    }
    for (const fileTitle of fileOrder) {
      md += `### 📄 ${displayFile(fileTitle)}\n\n`;
      // Why this file is in scope: the file(s) whose change pulled it in. Lets
      // a reader see, e.g., that chat shows only because a shared entry point
      // (apps/api/src/app.ts) changed, not the chat feature itself.
      const trigger = byFile.get(fileTitle).find((t) => t.relationReason);
      if (scopingActive && trigger?.relationReason && trigger.relationFiles.length > 0) {
        md += `> 🔍 **${trigger.relationReason}**: ${trigger.relationFiles.map((f) => `\`${f}\``).join(", ")}\n\n`;
      }
      let lastDescribe = null;
      for (const test of byFile.get(fileTitle)) {
        const describe = stripTags(test.describePath ?? "");
        if (describe && describe !== lastDescribe) {
          md += `**${describe}**\n\n`;
          lastDescribe = describe;
        }
        const media = test.media ?? { screenshots: [], gifs: [] };
        const tags = [...new Set(test.title.match(/@[\w-]+/g) ?? [])];
        const tagBadges = tags.map((t) => `<code>${t}</code>`).join(" ");
        const descLine = test.description ? `<br>📝 ${test.description}` : "";
        md += `<details${isFailure(test) ? " open" : ""}><summary>${icon[test.status] ?? "❔"} <b>${stripTags(test.leaf ?? test.title)}</b> ${tagBadges} <em>(${(test.durationMs / 1000).toFixed(1)}s)</em>${descLine}</summary>\n\n`;
        if (isFailure(test) && test.error) {
          const excerpt = stripAnsi(test.error).split("\n").slice(0, 6).join("\n");
          md += `> [!CAUTION]\n`;
          for (const line of excerpt.split("\n")) md += `> ${line}\n`;
          md += `\n`;
        }
        if (media.screenshots.length === 0 && media.gifs.length === 0) {
          md += `_このテストのメディアはありません_\n`;
        }
        for (const gif of media.gifs) {
          md += `#### 📹 実行の録画\n\n![録画](${blobBase}/${toRepoPath(gif)}?raw=true)\n\n`;
        }
        if (media.screenshots.length > 0) {
          md += `#### 🖼️ 画面の遷移(操作順)\n\n`;
          media.screenshots.forEach(({ file: shot, label }, i) => {
            md += `**Step ${i + 1}: ${label}**\n\n![${label}](${blobBase}/${toRepoPath(shot)}?raw=true)\n\n`;
          });
        }
        md += `</details>\n\n`;
      }
    }
  };

  const failedDetailed = detailed.filter(isFailure);
  const passedDetailed = detailed.filter((t) => !isFailure(t));
  if (failedDetailed.length > 0) {
    md += `## ❌ 失敗(${failedDetailed.length})\n\n`;
    renderTree(failedDetailed);
  }
  // Passed related tests split by novelty: newly-implemented (this PR added the
  // spec file) vs pre-existing (shown because a shared/related file changed).
  const newPassed = passedDetailed.filter((t) => t.isNew);
  const existingPassed = passedDetailed.filter((t) => !t.isNew);
  if (scopingActive && newPassed.length > 0) {
    md += `## 🆕 このPRで追加された機能のテスト(${newPassed.length})\n\n`;
    renderTree(newPassed);
  }
  if (existingPassed.length > 0) {
    const title =
      scopingActive && newPassed.length > 0
        ? `## ♻️ 既存テスト(このPRの変更に関連・${existingPassed.length})`
        : `## ✅ 成功(${existingPassed.length})`;
    md += `${title}\n\n`;
    if (scopingActive && newPassed.length > 0) {
      md += `<sub>これらは新機能そのものではなく、変更したファイルが波及するため表示されています(各見出しの 🔍 参照)。</sub>\n\n`;
    }
    renderTree(existingPassed);
  }

  if (collapsed.length > 0) {
    md += `<details><summary>⏩ このPRの変更対象外(${collapsed.length}本、すべて成功)</summary>\n\n`;
    let lastFile = null;
    for (const test of collapsed) {
      const fileTitle = test.fileTitle ?? "(unknown)";
      if (fileTitle !== lastFile) {
        md += `- ${displayFile(fileTitle)}\n`;
        lastFile = fileTitle;
      }
      md += `  - ${icon[test.status] ?? "❔"} ${stripTags(test.leaf ?? test.title)}`;
      if (test.description) md += ` — ${test.description}`;
      md += `\n`;
    }
    md += `\n</details>\n\n`;
  }

  // スコープ表示は「変更関連だけ」を絞り込む。全テストの録画を見たいときの逃げ道:
  // CI は全テストの動画を毎回記録し playwright-report を artifact 化している
  // (成功/失敗問わず・14日保持)。ここへ導線を張り、絞り込みで隠れた録画にも
  // ダウンロード一発で到達できるようにする。
  if (scopingActive) {
    const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
    md += `> [!NOTE]\n`;
    md += `> 🎥 **全テストの録画を見たいとき** — このrunの \`playwright-report\` アーティファクトに全テストの動画が入っています(スコープ外も含め全件・14日保持)。`;
    md += `[run を開く](${runUrl})→ 下部の Artifacts、または \`gh run download ${runId} -n playwright-report -D pw-report && npx playwright show-report pw-report\`。\n\n`;
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
