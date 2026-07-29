import { defineConfig } from "vite-plus";

// The api workspace previously ran `vp test` with no config (Vitest defaults).
// It now needs a globalSetup to supply a temporary PostgreSQL for the tickets
// store integration lane (spec: specs/database.md). Multiple test files now
// touch the shared temp DB (tickets-store + ticket-messages) and each resets
// schema+seed in beforeEach; fileParallelism: false serialises them so one
// file's reset can't wipe another's rows mid-test.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
