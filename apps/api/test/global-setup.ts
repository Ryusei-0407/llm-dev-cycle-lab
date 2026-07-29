// Vitest globalSetup for the tickets store integration lane (spec: specs/database.md).
//
// Skeleton only — the implementer owns the body and the wiring into the api
// vitest config. Contract expected by tickets-store.test.ts:
//   - provision (DATABASE_URL unset) or reset (DATABASE_URL set) a temporary
//     PostgreSQL via scripts/test-db.mjs, apply schema + seed, then expose the
//     connection string as process.env.DATABASE_URL for the test run
//   - teardown (return value / provided() cleanup) stops any container it started
//
// Until this is implemented, process.env.DATABASE_URL is undefined at test time,
// so the Pool cannot connect and the integration tests fail (intended RED).
export default async function setup(): Promise<void> {
  // implementer: provision/reset temp DB, set process.env.DATABASE_URL, seed.
}
