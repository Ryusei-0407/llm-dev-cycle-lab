import { ORPCError, os } from "@orpc/server";
import type { User } from "../auth/users.js";
import { createPool } from "../db.js";
import { createInput, setStatusInput } from "./schema.js";
import { createTicketStore, NotFoundError, type TicketStore } from "./store.js";

// The oRPC context carries the session user resolved at the /api/rpc mount
// (app.ts injects resolveUser(c)). null means unauthenticated: create requires
// it, list/setStatus ignore it for now (authz is M3, per specs/session-requester.md).
const base = os.$context<{ user: User | null }>();

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
  list: base.handler(() => getStore().list()),

  create: base
    .input(createInput)
    // requesterEmail is derived from the session user, not the public input:
    // create is session-required, so context.user null is UNAUTHORIZED.
    .handler(({ input, context }) => {
      if (!context.user) throw new ORPCError("UNAUTHORIZED");
      return getStore().create({ ...input, requesterEmail: context.user.email });
    }),

  setStatus: base.input(setStatusInput).handler(async ({ input }) => {
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
