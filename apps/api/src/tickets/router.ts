import { ORPCError, os } from "@orpc/server";
import { createPool } from "../db.js";
import { createInput, setStatusInput } from "./schema.js";
import { createTicketStore, NotFoundError, type TicketStore } from "./store.js";

// Lazy, process-wide pool + store: built on first tickets access from
// DATABASE_URL and reused for the life of the app instance. Missing DATABASE_URL
// is surfaced as 500 db_misconfigured (Hono guard in app.ts) — never a silent
// connect-to-nowhere. Callers reach the store only through getStore(), so the
// guard runs before any query.
let store: TicketStore | undefined;

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function getStore(): TicketStore {
  if (!store) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      // Should be unreachable: the Hono guard rejects before we get here. Kept
      // as a hard invariant so a missing guard fails loudly, not silently.
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "db_misconfigured" });
    }
    store = createTicketStore(createPool(url));
  }
  return store;
}

// oRPC drops the query/mutation distinction: every procedure is a .handler().
// The router is a plain object, not a builder call.
export const ticketsRouter = {
  list: os.handler(() => getStore().list()),

  create: os
    .input(createInput)
    // requesterEmail is not part of the public input contract yet: the router
    // stamps the historical fixed customer (session-derived requester is a
    // future spec). Observable behaviour is unchanged from the in-memory store.
    .handler(({ input }) =>
      getStore().create({ ...input, requesterEmail: "customer@example.com" }),
    ),

  setStatus: os.input(setStatusInput).handler(async ({ input }) => {
    try {
      return await getStore().setStatus(input.id, input.status);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
      }
      throw err;
    }
  }),
};

export const appRouter = {
  tickets: ticketsRouter,
};

export type AppRouter = typeof appRouter;
