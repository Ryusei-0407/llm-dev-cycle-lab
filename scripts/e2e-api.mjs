// E2E api launcher (spec: specs/database.md). Playwright starts webServers
// *before* globalSetup, so the DB the api needs at boot cannot come from
// globalSetup — this launcher owns it instead:
//   - DATABASE_URL set (CI service container / BYO) → reset (schema+seed), then
//     start the api against it. No container to tear down.
//   - DATABASE_URL unset (local) → provision a throwaway postgres:18-alpine,
//     set DATABASE_URL, start the api, and stop the container when the api
//     exits or this process is signalled (so nothing lingers after E2E).
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySchemaAndSeed, provision } from "./test-db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiEntry = path.resolve(here, "..", "apps", "api", "src", "index.ts");

let containerName;

// Synchronous stop so teardown completes before the process exits, even when
// Playwright signals the webServer with a short grace period before SIGKILL.
// --rm on the container means `docker stop` also removes it.
function stopDbSync() {
  if (!containerName) return;
  const name = containerName;
  containerName = undefined;
  try {
    execFileSync("docker", ["stop", name], { stdio: "ignore" });
  } catch {
    // Already gone / docker unavailable — nothing to clean up.
  }
}

async function ensureDb() {
  const existing = process.env.DATABASE_URL;
  if (existing) {
    await applySchemaAndSeed(existing);
    return existing;
  }
  const provisioned = await provision();
  containerName = provisioned.containerName;
  return provisioned.url;
}

const url = await ensureDb();

const child = spawn("node", ["--import", "tsx", apiEntry], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});

// Belt-and-suspenders: stop the container on child exit, on our own exit, and
// on the signals Playwright uses to kill the webServer.
child.on("exit", (code, signal) => {
  stopDbSync();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
    stopDbSync();
    process.exit(0);
  });
}

process.on("exit", stopDbSync);
