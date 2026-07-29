import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Reliable container cleanup: e2e-api.mjs stops its container on a catchable
// signal, but Playwright's webServer teardown does not always deliver one the
// launcher can trap (shell wrapping / SIGKILL). globalTeardown runs after all
// webServers are torn down, so it is the dependable place to stop any temp
// postgres this run left behind. Matches on the shared label
// (llmlab-e2e-pg=1). No-op in the BYO/CI-service-container case (those are not
// labelled by us). Spec: specs/database.md.
export default async function globalTeardown(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-q",
      "--filter",
      "label=llmlab-e2e-pg=1",
    ]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length > 0) {
      await execFileAsync("docker", ["stop", ...ids]);
    }
  } catch {
    // docker unavailable or nothing to stop — cleanup is best-effort.
  }
}
