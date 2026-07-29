// Temporary PostgreSQL supplier for the tickets store lane (spec:
// specs/database.md). Two modes, keyed on DATABASE_URL:
//
//   - provision (DATABASE_URL unset): docker run a throwaway postgres:18-alpine
//     on a random free port with a unique name (--rm), wait for readiness,
//     apply schema + seed, and return the connection URL. --teardown stops it.
//   - reset (DATABASE_URL set, e.g. CI's postgres service container): apply
//     schema + seed to that DB only, no container lifecycle.
//
// applySchemaAndSeed(url) is idempotent (schema.sql drops the table first) so
// vitest beforeEach can re-seed between cases. Also usable as a CLI:
//   node scripts/test-db.mjs provision   # prints DATABASE_URL=... on stdout
//   node scripts/test-db.mjs reset       # requires DATABASE_URL
//   node scripts/test-db.mjs teardown --name <container>
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "..", "apps", "api", "db");

const POSTGRES_IMAGE = "postgres:18-alpine";
const POSTGRES_PASSWORD = "postgres";
const POSTGRES_USER = "postgres";
const POSTGRES_DB = "postgres";

async function docker(args, opts = {}) {
  return execFileAsync("docker", args, opts);
}

// A free ephemeral port. Racy in principle (the port could be taken between
// close and docker binding it), but the window is tiny and each run picks a
// fresh one, so parallel worktrees do not collide on a fixed port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function readSql(name) {
  return readFile(path.join(dbDir, name), "utf8");
}

// Idempotent: schema.sql begins with DROP TABLE IF EXISTS, so applying twice
// leaves exactly the 3 seeds (no duplicates). Runs schema then seed in one
// pooled connection.
export async function applySchemaAndSeed(url) {
  const schema = await readSql("schema.sql");
  const seed = await readSql("seed.sql");
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(schema);
    await pool.query(seed);
  } finally {
    await pool.end();
  }
}

// Poll until postgres accepts a real connection (not just an open TCP port —
// the server rejects connections briefly during init). Bounded so a broken
// container fails loudly instead of hanging the test run.
async function waitForReady(url, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        throw new Error(`postgres not ready after ${timeoutMs}ms: ${lastErr?.message}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// Start a throwaway postgres:18-alpine and return { url, containerName }.
// Unique name + random host port so parallel worktrees never collide. --rm so
// a `docker stop` (teardown) also removes it; nothing lingers. Every container
// carries the llmlab-e2e-pg label so a sweep (docker stop --filter label=...)
// can reliably clean up even if a launcher misses its stop signal.
export const LABEL = "llmlab-e2e-pg=1";

export async function provision() {
  const port = await freePort();
  const containerName = `llmlab-pg-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "--label",
    LABEL,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_USER=${POSTGRES_USER}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "-p",
    `127.0.0.1:${port}:5432`,
    POSTGRES_IMAGE,
  ]);
  const url = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
  try {
    await waitForReady(url);
    await applySchemaAndSeed(url);
  } catch (err) {
    await teardown(containerName).catch(() => {});
    throw err;
  }
  return { url, containerName };
}

// Stop (and, via --rm, remove) a provisioned container. Idempotent-ish: a
// missing container is not an error worth failing teardown over.
export async function teardown(containerName) {
  if (!containerName) return;
  await docker(["stop", containerName]).catch(() => {});
}

async function reset(url) {
  if (!url) throw new Error("reset モードは DATABASE_URL が必要です");
  await applySchemaAndSeed(url);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  switch (cmd) {
    case "provision": {
      // If a DATABASE_URL is already provided, provision degrades to reset
      // (BYO DB, e.g. CI service container) — same contract as the library.
      if (url) {
        await reset(url);
        process.stdout.write(`DATABASE_URL=${url}\n`);
        return;
      }
      const { url: provisioned, containerName } = await provision();
      process.stdout.write(`DATABASE_URL=${provisioned}\n`);
      process.stdout.write(`CONTAINER=${containerName}\n`);
      return;
    }
    case "reset":
      await reset(url);
      return;
    case "teardown": {
      const nameFlag = rest.indexOf("--name");
      const name = nameFlag >= 0 ? rest[nameFlag + 1] : undefined;
      await teardown(name);
      return;
    }
    default:
      process.stderr.write("usage: test-db.mjs <provision|reset|teardown --name <container>>\n");
      process.exitCode = 2;
  }
}

// Support both `--teardown` (spec wording) and the `teardown` subcommand.
if (process.argv.includes("--teardown")) {
  const rest = process.argv.slice(2);
  const nameFlag = rest.indexOf("--name");
  const name = nameFlag >= 0 ? rest[nameFlag + 1] : undefined;
  teardown(name).catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
