#!/usr/bin/env node
// Parses Playwright trace.zip files and prints a Markdown report of
// slow actions, slow/failed network requests, and console errors.
// Usage: node scripts/analyze-trace.mjs [dir-containing-trace-zips] [--slow-ms=500]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const slowMs = Number(
  (args.find((a) => a.startsWith("--slow-ms=")) ?? "--slow-ms=500").split("=")[1],
);
const rootDir = args.find((a) => !a.startsWith("--")) ?? "e2e/test-results";

function findTraceZips(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...findTraceZips(full));
    else if (entry.endsWith(".zip") && entry.includes("trace")) out.push(full);
  }
  return out;
}

function parseNdjson(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* tolerate unknown lines */
    }
  }
  return events;
}

// Server-Timing ヘッダ(`app;dur=12.3, db;dur=4.5;desc="2 queries"`)を
// {app: 12.3, db: 4.5, dbQueries: 2} に分解する。API 側の付与は
// apps/api/src/server-timing.ts — バックエンド内訳の一次データ。
function parseServerTiming(headers) {
  const header = (headers ?? []).find((h) => h.name?.toLowerCase() === "server-timing");
  if (!header?.value) return null;
  const out = {};
  for (const part of header.value.split(",")) {
    const m = part.trim().match(/^([\w-]+);dur=([\d.]+)(?:;desc="(\d+) queries")?/);
    if (!m) continue;
    out[m[1]] = Number(m[2]);
    if (m[1] === "db" && m[3]) out.dbQueries = Number(m[3]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// /api パスをエンドポイント単位に正規化(uuid は :id に畳む)。
function apiEndpoint(url) {
  try {
    return new URL(url).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{17,}/gi, ":id");
  } catch {
    return url;
  }
}

function analyzeTrace(zipPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "pw-trace-"));
  const result = { actions: [], network: [], console: [] };
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
    const files = readdirSync(dir);

    for (const file of files.filter((f) => f.endsWith(".trace"))) {
      const events = parseNdjson(path.join(dir, file));
      const pending = new Map();
      for (const event of events) {
        if (event.type === "before" && event.callId) {
          pending.set(event.callId, event);
        } else if (event.type === "after" && event.callId) {
          const before = pending.get(event.callId);
          if (before?.startTime && event.endTime) {
            result.actions.push({
              api: before.apiName ?? before.method ?? "unknown",
              title: before.title ?? before.params?.selector ?? "",
              durationMs: Math.round(event.endTime - before.startTime),
              error: event.error?.error?.message ?? null,
            });
          }
          pending.delete(event.callId);
        } else if (event.type === "console") {
          result.console.push({
            level: event.messageType ?? event.level ?? "log",
            text: (event.text ?? "").slice(0, 200),
          });
        }
      }
    }

    for (const file of files.filter((f) => f.endsWith(".network"))) {
      for (const event of parseNdjson(path.join(dir, file))) {
        const snapshot = event.snapshot ?? event;
        const request = snapshot.request;
        const response = snapshot.response;
        if (!request?.url) continue;
        result.network.push({
          method: request.method ?? "GET",
          url: request.url,
          status: response?.status ?? 0,
          durationMs: Math.round(snapshot.time ?? 0),
          serverTiming: parseServerTiming(response?.headers),
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

const zips = findTraceZips(rootDir);
if (zips.length === 0) {
  console.error(`no trace zips found under ${rootDir}`);
  console.error("run: pnpm e2e:perf  (or download the perf-traces artifact)");
  process.exit(1);
}

const all = { actions: [], network: [], console: [] };
for (const zip of zips) {
  const result = analyzeTrace(zip);
  const label = path.relative(rootDir, zip);
  for (const a of result.actions) all.actions.push({ ...a, trace: label });
  for (const n of result.network) all.network.push({ ...n, trace: label });
  for (const c of result.console) all.console.push({ ...c, trace: label });
}

console.log(`# Playwright trace analysis\n`);
console.log(`Analyzed ${zips.length} trace(s) under \`${rootDir}\`.\n`);

console.log(`## Slowest actions (top 15)\n`);
console.log("| duration | action | detail | trace |");
console.log("|---:|---|---|---|");
for (const a of [...all.actions].sort((x, y) => y.durationMs - x.durationMs).slice(0, 15)) {
  console.log(
    `| ${a.durationMs}ms | ${a.api} | ${String(a.title).replaceAll("|", "\\|")} | ${a.trace} |`,
  );
}

const slowNet = all.network.filter((n) => n.durationMs >= slowMs);
const failedNet = all.network.filter((n) => n.status >= 400);
console.log(`\n## Network: slow (>=${slowMs}ms) or failed requests\n`);
if (slowNet.length === 0 && failedNet.length === 0) {
  console.log("None.");
} else {
  console.log("| duration | status | method | url | trace |");
  console.log("|---:|---:|---|---|---|");
  for (const n of [...new Set([...failedNet, ...slowNet])].sort(
    (x, y) => y.durationMs - x.durationMs,
  )) {
    console.log(`| ${n.durationMs}ms | ${n.status} | ${n.method} | ${n.url} | ${n.trace} |`);
  }
}

// エンドポイント別のバックエンド内訳(Server-Timing 由来)。app = ハンドラ合計、
// db = リクエスト中の全クエリ合計。app と db の差が大きい行はアプリ側の処理、
// db が支配的な行はクエリが最適化候補、という読み方をする。
const apiCalls = all.network.filter((n) => n.serverTiming && n.url.includes("/api/"));
console.log(`\n## API endpoints (Server-Timing backend breakdown)\n`);
if (apiCalls.length === 0) {
  console.log("None. (API 側の Server-Timing ヘッダ付与後のトレースが必要)");
} else {
  const byEndpoint = new Map();
  for (const n of apiCalls) {
    const key = `${n.method} ${apiEndpoint(n.url)}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(n);
  }
  const stats = (nums) => ({
    avg: nums.reduce((s, v) => s + v, 0) / (nums.length || 1),
    max: Math.max(0, ...nums),
  });
  const rows = [...byEndpoint.entries()]
    .map(([key, calls]) => {
      const app = stats(calls.map((c) => c.serverTiming.app ?? 0));
      const db = stats(calls.map((c) => c.serverTiming.db ?? 0));
      const queries = calls.reduce((s, c) => s + (c.serverTiming.dbQueries ?? 0), 0);
      return { key, count: calls.length, app, db, queries };
    })
    .sort((x, y) => y.app.max - x.app.max);
  console.log("| endpoint | calls | app avg/max | db avg/max | queries |");
  console.log("|---|---:|---:|---:|---:|");
  for (const r of rows.slice(0, 20)) {
    console.log(
      `| ${r.key} | ${r.count} | ${r.app.avg.toFixed(1)}/${r.app.max.toFixed(1)}ms | ${r.db.avg.toFixed(1)}/${r.db.max.toFixed(1)}ms | ${r.queries} |`,
    );
  }
}

const problems = all.console.filter((c) => c.level === "error" || c.level === "warning");
console.log(`\n## Console errors / warnings\n`);
if (problems.length === 0) {
  console.log("None.");
} else {
  console.log("| level | message | trace |");
  console.log("|---|---|---|");
  for (const c of problems.slice(0, 30)) {
    console.log(`| ${c.level} | ${c.text.replaceAll("|", "\\|")} | ${c.trace} |`);
  }
}

const actionErrors = all.actions.filter((a) => a.error);
console.log(`\n## Failed / retried actions\n`);
if (actionErrors.length === 0) {
  console.log("None.");
} else {
  console.log("| action | error | trace |");
  console.log("|---|---|---|");
  for (const a of actionErrors.slice(0, 30)) {
    console.log(
      `| ${a.api} ${String(a.title).replaceAll("|", "\\|")} | ${String(a.error).slice(0, 120).replaceAll("|", "\\|")} | ${a.trace} |`,
    );
  }
}
