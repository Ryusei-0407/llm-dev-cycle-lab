import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applySchemaAndSeed, provision, teardown } from "../scripts/test-db.mjs";

// Worker-per-stack isolation: each Playwright worker owns a full backend stack
// — a throwaway postgres container, an api process, and a web dev server on
// worker-scoped ports — and every test starts from a freshly reset database.
// The app itself carries no test-specific wiring: isolation comes from the
// environment (separate processes and ports), and the per-test reset runs
// directly against the worker's own database.
//
// Auth is deliberately NOT re-tested here: the login/passkey flows have their
// own specs. Every reset re-seeds two fixed-sid session rows, and the
// storageState files (setup/auth.setup.ts) simply point at those sids — other
// tests start authenticated without ever driving a login.

export type WorkerStack = {
  webURL: string;
  dbURL: string;
  stop(): Promise<void>;
};

// Fixed session ids planted into every worker database on every reset. v4
// literals (an opaque token, no ordering needed — mirrors sessions.create's
// randomUUID) with a recognisable e2e suffix.
export const FIXED_SIDS = {
  agent: "00000000-0000-4000-8000-00000000e2ea",
  customer: "00000000-0000-4000-8000-00000000e2ec",
} as const;

// Seed user ids from apps/api/db/seed.sql — the sessions rows must reference
// them, and the seed pins them as fixed v7 literals.
const SEED_USER_IDS = {
  agent: "00000000-0000-7000-8000-0000000000a1",
  customer: "00000000-0000-7000-8000-0000000000a2",
} as const;

async function seedSessions(dbURL: string): Promise<void> {
  const client = new pg.Client({ connectionString: dbURL });
  await client.connect();
  try {
    await client.query("INSERT INTO sessions (sid, user_id) VALUES ($1, $2), ($3, $4)", [
      FIXED_SIDS.agent,
      SEED_USER_IDS.agent,
      FIXED_SIDS.customer,
      SEED_USER_IDS.customer,
    ]);
  } finally {
    await client.end();
  }
}

// Per-test reset: schema + seed (idempotent DROP/CREATE) + the fixed sessions.
// ~0.1-0.3s against a local container — the price of every test starting from
// the identical, fully deterministic state (SUP numbers included).
export async function resetStackDb(dbURL: string): Promise<void> {
  await applySchemaAndSeed(dbURL);
  await seedSessions(dbURL);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForHttp(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet — keep polling.
    }
    if (Date.now() > deadline) throw new Error(`not ready after ${timeoutMs}ms: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Kill the whole process group: `pnpm dev` wraps vite in a child of its own,
// and a plain child.kill would orphan it. detached:true puts each stack
// process in its own group so -pid reaches every descendant.
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

export async function startStack(workerIndex: number): Promise<WorkerStack> {
  // Worker-scoped ports, offset from the env base so parallel worktrees (which
  // set different WEB_PORT/API_PORT) never collide with each other, and the
  // offset (+11) never collides with the base ports themselves (the config
  // webServer still serves the components project on the base web port).
  const webPort = Number(process.env.WEB_PORT ?? 5173) + 11 + workerIndex * 2;
  const apiPort = Number(process.env.API_PORT ?? 8787) + 11 + workerIndex * 2;

  const db = await provision();

  const children: ChildProcess[] = [];
  let stopped = false;
  const spawnChild = (cmd: string, args: string[], env: Record<string, string>) => {
    const child = spawn(cmd, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, ...env },
    });
    children.push(child);
    return child;
  };

  spawnChild("node", ["--import", "tsx", "apps/api/src/index.ts"], {
    DATABASE_URL: db.url,
    API_PORT: String(apiPort),
    // E2E はモック強制で .env(1Password FIFO)を読まない。実 Gemini は
    // nightly の LLM_SMOKE=1 レーンだけ(従来の webServer 設定と同値)。
    API_ENV_FILE: ".env.e2e-none",
    MOCK_DELAY_MS: "20",
    LLM_PROVIDER: process.env.LLM_SMOKE === "1" ? "gemini" : "mock",
  });
  spawnChild("pnpm", ["--filter", "@app/web", "dev"], {
    WEB_PORT: String(webPort),
    API_PORT: String(apiPort),
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const child of children) killTree(child, "SIGTERM");
    await teardown(db.containerName);
  };

  // Backstop for abrupt worker death (SIGKILL'd runner, crash): 'exit' allows
  // sync work only. The container is also swept by global-teardown's label
  // filter, so this is belt-and-suspenders.
  process.on("exit", () => {
    if (stopped) return;
    for (const child of children) killTree(child, "SIGKILL");
    try {
      execFileSync("docker", ["stop", db.containerName], { stdio: "ignore" });
    } catch {
      // Best-effort.
    }
  });

  try {
    await Promise.all([
      waitForHttp(`http://localhost:${apiPort}/api/health`),
      waitForHttp(`http://localhost:${webPort}/`),
    ]);
    await seedSessions(db.url);
  } catch (err) {
    await stop();
    throw err;
  }

  return { webURL: `http://localhost:${webPort}`, dbURL: db.url, stop };
}
