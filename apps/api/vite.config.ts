import { defineConfig } from "vite-plus";

// The api workspace previously ran `vp test` with no config (Vitest defaults).
// It now needs a globalSetup to supply a temporary PostgreSQL for the tickets
// store integration lane (spec: specs/database.md). Two test files now share
// that temp DB (tickets-store + session-requester), each resetting schema+seed
// per test; fileParallelism: false serializes them so their resets can't
// interleave and cross-contaminate. The api unit lane runs in a few seconds,
// so serial execution costs nothing observable.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
