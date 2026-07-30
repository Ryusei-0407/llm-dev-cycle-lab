import { ORPCError, os } from "@orpc/server";
import type { User } from "../auth/users.js";
import { createPool } from "../db.js";
import { createMessageStore, type MessageStore } from "./messages.js";
import { createInput, getInput, replyInput, setStatusInput } from "./schema.js";
import { createTicketStore, NotFoundError, type TicketStore } from "./store.js";

// Per-request context injected at the /api/rpc mount (app.ts injects
// resolveUser(c)): the resolved session user, or null when the request carries
// no valid session. Every tickets.* procedure is session-required (null →
// UNAUTHORIZED) and role-scoped per specs/authz.md.
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

// Every tickets.* procedure requires a session. Resolve it once at the top of a
// handler and surface a null user as UNAUTHORIZED (specs/authz.md).
function requireUser(user: User | null): User {
  if (!user) throw new ORPCError("UNAUTHORIZED", { message: "not authenticated" });
  return user;
}

// get/reply share existence → ownership ordering: a missing ticket is NOT_FOUND
// (never leaked as FORBIDDEN), and a customer touching someone else's ticket is
// FORBIDDEN. An agent may reach any ticket. Returns the found ticket so callers
// can reuse it.
async function loadAuthorizedTicket(user: User, id: string) {
  const tickets = await getStore().list();
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) {
    throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
  }
  if (user.role !== "agent" && ticket.requesterEmail !== user.email) {
    throw new ORPCError("FORBIDDEN", { message: "not your ticket" });
  }
  return ticket;
}

// oRPC drops the query/mutation distinction: every procedure is a .handler().
// The router is a plain object, not a builder call.
export const ticketsRouter = {
  // Role-scoped list: an agent sees every ticket; a customer sees only their own
  // (store filter by requesterEmail). Session required.
  list: base.handler(({ context }) => {
    const user = requireUser(context.user);
    return user.role === "agent"
      ? getStore().list()
      : getStore().list({ requesterEmail: user.email });
  }),

  create: base
    .input(createInput)
    // requesterEmail is derived from the session user, not the public input:
    // create is session-required, so context.user null is UNAUTHORIZED.
    .handler(({ input, context }) => {
      const user = requireUser(context.user);
      return getStore().create({ ...input, requesterEmail: user.email });
    }),

  // setStatus is agent-only: a customer is FORBIDDEN even for their own ticket
  // (specs/authz.md). Session required.
  setStatus: base.input(setStatusInput).handler(async ({ input, context }) => {
    const user = requireUser(context.user);
    if (user.role !== "agent") {
      throw new ORPCError("FORBIDDEN", { message: "agent only" });
    }
    try {
      return await getStore().setStatus(input.id, input.status);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
      }
      throw err;
    }
  }),

  // Ticket detail: the ticket plus its thread. Existence → ownership: a missing
  // ticket is NOT_FOUND, a customer's cross-owner access is FORBIDDEN.
  get: base.input(getInput).handler(async ({ input, context }) => {
    const user = requireUser(context.user);
    const ticket = await loadAuthorizedTicket(user, input.id);
    const messages = await getMessageStore().listByTicket(input.id);
    return { ticket, messages };
  }),

  // Post a reply. The author is the session user (context.user), never client
  // input. Existence → ownership gates it (missing → NOT_FOUND, cross-owner
  // customer → FORBIDDEN) before the message is created.
  reply: base.input(replyInput).handler(async ({ input, context }) => {
    const user = requireUser(context.user);
    await loadAuthorizedTicket(user, input.ticketId);
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
