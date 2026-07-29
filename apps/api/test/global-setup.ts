// Vitest globalSetup for the tickets store integration lane (spec:
// specs/database.md). Runs once in the main process before test workers fork,
// so the DATABASE_URL it sets is inherited by every worker.
//
//   - DATABASE_URL unset → provision a throwaway postgres:18-alpine via
//     scripts/test-db.mjs (docker), set DATABASE_URL, and stop the container in
//     the returned teardown.
//   - DATABASE_URL set (CI service container / BYO) → apply schema + seed to
//     that DB only; teardown is a no-op (we did not start it).
import { applySchemaAndSeed, provision, teardown } from "../../../scripts/test-db.mjs";

export default async function setup(): Promise<() => Promise<void>> {
  const existing = process.env.DATABASE_URL;
  if (existing) {
    await applySchemaAndSeed(existing);
    return async () => {};
  }

  const { url, containerName } = await provision();
  process.env.DATABASE_URL = url;
  return async () => {
    delete process.env.DATABASE_URL;
    await teardown(containerName);
  };
}
