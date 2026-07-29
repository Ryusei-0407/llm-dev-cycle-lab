import { defineConfig } from "vite-plus";

// The api workspace previously ran `vp test` with no config (Vitest defaults).
// It now needs a globalSetup to supply a temporary PostgreSQL for the tickets
// store integration lane (spec: specs/database.md). Only one test file touches
// the DB (test/tickets-store.test.ts) and it resets schema+seed in beforeEach,
// so the shared temp DB is safe under Vitest's default file parallelism.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
});
