import { ORPCError, os } from "@orpc/server";
import type { User } from "../auth/users.js";
import { createPool } from "../db.js";
import { createRealtimeHub, type RealtimeHub } from "../realtime.js";
import { createMessageStore, type MessageStore } from "./messages.js";
import {
  createInput,
  getInput,
  listPageInput,
  replyInput,
  searchInput,
  setAssigneeInput,
  setLabelsInput,
  setStatusInput,
} from "./schema.js";
import { BadRequestError, createTicketStore, NotFoundError, type TicketStore } from "./store.js";

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
  const ticket = await getStore().getById(id);
  if (!ticket) {
    throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
  }
  if (user.role !== "agent" && ticket.requesterEmail !== user.email) {
    throw new ORPCError("FORBIDDEN", { message: "not your ticket" });
  }
  return ticket;
}

// oRPC drops the query/mutation distinction: every procedure is a .handler().
// The router is built per-app so the ws-realtime hub can be injected: after a
// successful create/setStatus/reply the handler broadcasts a {type, ticketId}
// event through `hub`, and open clients invalidate their own authorised query.
// draft (下書き) deliberately does NOT broadcast (spec: specs/ws-realtime.md).
export function createTicketsRouter(hub: RealtimeHub) {
  // The three agent-only mutations (setStatus/setAssignee/setLabels) share one
  // shape: session-required + agent role, run the store mutation once mapping its
  // errors to oRPC, then broadcast ticket.updated only on a real change. The
  // store returns the unchanged ticket on a same-value no-op (no event, no
  // updated_at bump), so comparing updatedAt against a pre-read distinguishes a
  // real change from a no-op without mutating twice.
  async function agentMutation<T extends { updatedAt: string }>(
    user: User | null,
    id: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const resolved = requireUser(user);
    if (resolved.role !== "agent") {
      throw new ORPCError("FORBIDDEN", { message: "agent only" });
    }
    const before = await getStore().getById(id);
    if (!before) throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
    let result: T;
    try {
      result = await mutate();
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
      }
      if (err instanceof BadRequestError) {
        throw new ORPCError("BAD_REQUEST", { message: err.message });
      }
      throw err;
    }
    if (result.updatedAt !== before.updatedAt) {
      hub.broadcast({ type: "ticket.updated", ticketId: id });
    }
    return result;
  }

  return {
    // Role-scoped list: an agent sees every ticket; a customer sees only their own
    // (store filter by requesterEmail). Session required.
    list: base.handler(({ context }) => {
      const user = requireUser(context.user);
      return user.role === "agent"
        ? getStore().list()
        : getStore().list({ requesterEmail: user.email });
    }),

    // command-palette search (spec: specs/command-palette.md). Role scope mirrors
    // list: an agent searches every ticket; a customer is pinned to their own via
    // the store's requesterEmail filter. Session required. No match is an empty
    // array (the store contract), never an error.
    search: base.input(searchInput).handler(({ input, context }) => {
      const user = requireUser(context.user);
      return getStore().search({
        q: input.q,
        requesterEmail: user.role === "agent" ? undefined : user.email,
      });
    }),

    create: base
      .input(createInput)
      // requesterEmail is derived from the session user, not the public input:
      // create is session-required, so context.user null is UNAUTHORIZED.
      .handler(async ({ input, context }) => {
        const user = requireUser(context.user);
        const ticket = await getStore().create({ ...input, requesterEmail: user.email });
        hub.broadcast({ type: "ticket.created", ticketId: ticket.id });
        return ticket;
      }),

    // setStatus is agent-only: a customer is FORBIDDEN even for their own ticket
    // (specs/authz.md). Session required. A same-value change is a no-op in the
    // store (no event, no updated_at bump) and does not broadcast — detected by
    // comparing updatedAt before/after.
    setStatus: base.input(setStatusInput).handler(({ input, context }) => {
      const user = requireUser(context.user);
      return agentMutation(context.user, input.id, () =>
        getStore().setStatus(input.id, input.status, user.email),
      );
    }),

    // setAssignee is agent-only. The store validates the target is a role='agent'
    // email (or null to unassign) and records assignee_changed + bumps updated_at
    // atomically. agentMutation broadcasts ticket.updated only on a real change.
    setAssignee: base.input(setAssigneeInput).handler(({ input, context }) => {
      const user = requireUser(context.user);
      return agentMutation(context.user, input.id, () =>
        getStore().setAssignee(input.id, input.assigneeEmail, user.email),
      );
    }),

    // setLabels is agent-only. Full replace by name; the store rejects unknown
    // names, normalises duplicates, and records labels_changed (name-sorted) +
    // bumps updated_at atomically. Broadcast only on a real change.
    setLabels: base.input(setLabelsInput).handler(({ input, context }) => {
      const user = requireUser(context.user);
      return agentMutation(context.user, input.id, () =>
        getStore().setLabels(input.id, input.labels, user.email),
      );
    }),

    // Label catalogue for the toggles. Session required, role-agnostic (spec).
    labels: base.handler(({ context }) => {
      requireUser(context.user);
      return getStore().labels();
    }),

    // Agent directory for the assignee select. Agent-only (spec).
    agents: base.handler(({ context }) => {
      const user = requireUser(context.user);
      if (user.role !== "agent") {
        throw new ORPCError("FORBIDDEN", { message: "agent only" });
      }
      return getStore().agents();
    }),

    // Keyset page of the same role-scoped list. Session required; role scope
    // mirrors list (agent → all, customer → own). A malformed cursor surfaces as
    // BAD_REQUEST "invalid cursor" from the store.
    listPage: base.input(listPageInput).handler(async ({ input, context }) => {
      const user = requireUser(context.user);
      try {
        return await getStore().listPage({
          cursor: input.cursor,
          limit: input.limit,
          requesterEmail: user.role === "agent" ? undefined : user.email,
          status: input.status,
          priority: input.priority,
          label: input.label,
          unassigned: input.unassigned,
          unresolved: input.unresolved,
        });
      } catch (err) {
        if (err instanceof BadRequestError) {
          throw new ORPCError("BAD_REQUEST", { message: err.message });
        }
        throw err;
      }
    }),

    // Inbox badge count (spec: specs/triage.md). Agent-only — a customer is
    // FORBIDDEN, mirroring agents(). Session required.
    inboxCount: base.handler(({ context }) => {
      const user = requireUser(context.user);
      if (user.role !== "agent") {
        throw new ORPCError("FORBIDDEN", { message: "agent only" });
      }
      return getStore().inboxCount();
    }),

    // insights dashboard aggregate (spec: specs/insights.md). Agent-only — a
    // customer is FORBIDDEN, mirroring inboxCount/agents. Session required. now
    // defaults to the store's new Date(); the deterministic value is exercised
    // at the store layer, not over the wire.
    insights: base.handler(({ context }) => {
      const user = requireUser(context.user);
      if (user.role !== "agent") {
        throw new ORPCError("FORBIDDEN", { message: "agent only" });
      }
      return getStore().insights();
    }),

    // Ticket detail: the ticket, its thread, and its activity log. Existence →
    // ownership: a missing ticket is NOT_FOUND, a customer's cross-owner access is
    // FORBIDDEN. events is created_at ASC (store contract).
    get: base.input(getInput).handler(async ({ input, context }) => {
      const user = requireUser(context.user);
      const ticket = await loadAuthorizedTicket(user, input.id);
      const messages = await getMessageStore().listByTicket(input.id);
      const events = await getStore().listEvents(input.id);
      return { ticket, messages, events };
    }),

    // Post a reply. The author is the session user (context.user), never client
    // input. Existence → ownership gates it (missing → NOT_FOUND, cross-owner
    // customer → FORBIDDEN) before the message is created. A successful reply
    // bumps the ticket's updated_at (spec: no event, just the touch).
    reply: base.input(replyInput).handler(async ({ input, context }) => {
      const user = requireUser(context.user);
      await loadAuthorizedTicket(user, input.ticketId);
      try {
        const message = await getMessageStore().create({
          ticketId: input.ticketId,
          authorEmail: user.email,
          authorRole: user.role,
          body: input.body,
        });
        await getStore().touch(input.ticketId);
        hub.broadcast({ type: "message.created", ticketId: input.ticketId });
        return message;
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
        }
        throw err;
      }
    }),
  };
}

// Type anchor for the oRPC client (apps/web/src/lib/orpc.ts imports AppRouter).
// Built with a throwaway hub purely to fix the router shape at the type level;
// the running app constructs its own router with the live hub in createApp.
export const appRouter = {
  tickets: createTicketsRouter(createRealtimeHub()),
};

export type AppRouter = typeof appRouter;
