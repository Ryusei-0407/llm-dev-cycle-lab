import { ORPCError, os } from "@orpc/server";
import type { User } from "../auth/users.js";
import { createPool } from "../db.js";
import { createMessageStore, type MessageStore } from "./messages.js";
import { createInput, getInput, replyInput, setStatusInput } from "./schema.js";
import { createTicketStore, NotFoundError, type TicketStore } from "./store.js";

// Per-request context injected at the /api/rpc mount (app.ts injects
// resolveUser(c)): the resolved session user, or null when the request carries
// no valid session. create and reply require it (null → UNAUTHORIZED);
// list/setStatus/get ignore it for now (authz is M3, per
// specs/session-requester.md).
export type TicketContext = { user: User | null };

const base = os.$context<TicketContext>();

// Lazy, process-wide pool + stores: built on first tickets access from
// DATABASE_URL and reused for the life of the app instance. Missing DATABASE_URL
// is surfaced as 500 db_misconfigured (Hono guard in app.ts) — never a silent
// connect-to-nowhere. Callers reach a store only through the getters, so the
// guard runs before any query.
let ticketStore: TicketStore | undefined;
let messageStore: MessageStore | undefined;

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function requireUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Should be unreachable: the Hono guard rejects before we get here. Kept
    // as a hard invariant so a missing guard fails loudly, not silently.
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "db_misconfigured" });
  }
  return url;
}

// Exported so the reply-draft Hono route (tickets/draft.ts) reads through the
// same lazy, process-wide pool + stores rather than opening its own — the DB
// guard in app.ts still runs first, so a missing DATABASE_URL never reaches a
// query.
export function getStore(): TicketStore {
  if (!ticketStore) {
    ticketStore = createTicketStore(createPool(requireUrl()));
  }
  return ticketStore;
}

export function getMessageStore(): MessageStore {
  if (!messageStore) {
    messageStore = createMessageStore(createPool(requireUrl()));
  }
  return messageStore;
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

  // Ticket detail: the ticket plus its thread. A missing ticket is NOT_FOUND
  // (setStatus already establishes NotFoundError → NOT_FOUND); listByTicket
  // returns [] for an absent ticket, so the ticket lookup is what gates it.
  get: base.input(getInput).handler(async ({ input }) => {
    const tickets = await getStore().list();
    const ticket = tickets.find((t) => t.id === input.id);
    if (!ticket) {
      throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
    }
    const messages = await getMessageStore().listByTicket(input.id);
    return { ticket, messages };
  }),

  // Post a reply. The author is the session user (context.user), never client
  // input — an unauthenticated request is UNAUTHORIZED. A reply to a missing
  // ticket surfaces as NOT_FOUND via the store's NotFoundError.
  reply: base.input(replyInput).handler(async ({ input, context }) => {
    const user = context.user;
    if (!user) {
      throw new ORPCError("UNAUTHORIZED", { message: "not authenticated" });
    }
    try {
      return await getMessageStore().create({
        ticketId: input.ticketId,
        authorEmail: user.email,
        authorRole: user.role,
        body: input.body,
      });
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
