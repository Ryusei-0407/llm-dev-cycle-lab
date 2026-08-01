import { z } from "zod";
import type { Pool } from "../db.js";
import { createInput } from "./schema.js";

export type TicketStatus = "open" | "in_progress" | "resolved";
export type TicketPriority = "low" | "medium" | "high";

// Reply lives in the store so a message + the ticket's updated_at touch commit
// together (spec: reply は履歴対象外 — no event). MessageRole/Message mirror
// messages.ts; kept as a local structural copy to avoid a store↔messages import
// cycle (messages.ts already imports NotFoundError from here).
export type MessageRole = "customer" | "agent";
export type Message = {
  id: string;
  ticketId: string;
  authorEmail: string;
  authorRole: MessageRole;
  body: string;
  createdAt: string;
};
export type ReplyStoreInput = {
  ticketId: string;
  authorEmail: string;
  authorRole: MessageRole;
  body: string;
};

export type Label = { name: string; color: string };

export type Ticket = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterEmail: string;
  assigneeEmail: string | null;
  labels: Label[];
  createdAt: string;
  updatedAt: string;
};

// Activity log (spec: specs/ticket-model.md). payload is the discriminated
// union the wire uses verbatim; the store persists it as jsonb and reads it
// back untouched.
export type TicketEventType = "status_changed" | "assignee_changed" | "labels_changed";
export type TicketEventPayload =
  | { from: TicketStatus; to: TicketStatus }
  | { from: string | null; to: string | null }
  | { from: string[]; to: string[] };

export type TicketEvent = {
  id: string;
  type: TicketEventType;
  actorEmail: string;
  payload: TicketEventPayload;
  createdAt: string;
};

export type CreateTicketInput = {
  subject: string;
  priority: TicketPriority;
  requesterEmail: string;
};

// Thrown by mutations when no row matches the id, so the router can map it to an
// oRPC NOT_FOUND without string-matching an error message.
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`NOT_FOUND: ticket ${id}`);
    this.name = "NotFoundError";
  }
}

// Thrown by setAssignee/setLabels when the input fails a catalogue/role check.
// The router maps it to an oRPC BAD_REQUEST carrying this message so the exact
// wording ("not an agent" / "unknown label") stays a store contract, not a
// router string literal.
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

// Column order matches the SELECT list; created_at/updated_at are normalised to
// ISO strings here (pg returns timestamptz as a Date), and labels arrives as a
// json_agg array already sorted by name. number is a bigint but stays well under
// 2^53 for this app, so pg's numeric→number is safe.
type Row = {
  id: string;
  number: string | number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requester_email: string;
  assignee_email: string | null;
  labels: Label[];
  created_at: Date;
  updated_at: Date;
};

function toTicket(row: Row): Ticket {
  return {
    id: row.id,
    number: Number(row.number),
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    requesterEmail: row.requester_email,
    assigneeEmail: row.assignee_email,
    labels: row.labels,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// labels is a correlated json_agg subquery so a ticket with no labels yields []
// (not [null]) and the whole list stays a single round trip — no N+1. The inner
// ORDER BY name makes the array deterministic (spec: name 昇順).
const LABELS_SUBQUERY = `
  COALESCE(
    (SELECT json_agg(json_build_object('name', l.name, 'color', l.color) ORDER BY l.name)
       FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
      WHERE tl.ticket_id = t.id),
    '[]'::json
  ) AS labels`;

const COLUMNS = `t.id, t.number, t.subject, t.status, t.priority, t.requester_email, t.assignee_email, t.created_at, t.updated_at, ${LABELS_SUBQUERY}`;

// Deterministic order: created_at DESC, then id DESC to break ties (seeds share
// no timestamp, but created rows land at now() and could collide).
const ORDER = "ORDER BY t.created_at DESC, t.id DESC";
const LIST_SQL = `SELECT ${COLUMNS} FROM tickets t ${ORDER}`;
const LIST_BY_REQUESTER_SQL = `SELECT ${COLUMNS} FROM tickets t WHERE t.requester_email = $1 ${ORDER}`;
const GET_BY_ID_SQL = `SELECT ${COLUMNS} FROM tickets t WHERE t.id = $1`;

// command-palette search (spec: specs/command-palette.md). A query that is a bare
// number, optionally SUP- prefixed (SUP-12 / 12), is an exact number match;
// anything else is a case-insensitive subject substring match. Capped at 20 rows
// under the list ordering.
const SEARCH_LIMIT = 20;
const NUMBER_QUERY = /^(?:SUP-)?(\d+)$/i;

// Escape the ILIKE meta-characters so a subject query is treated literally: % _
// (and the escape char itself) match themselves rather than acting as wildcards.
// The pattern is bound as a param and wrapped in %…% for a substring match.
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, "\\$&");
}

// Optional filter for role-scoped listing (specs/authz.md): a customer sees only
// their own tickets. The router owns the authorization decision; the store just
// applies the requesterEmail filter when asked. Existing no-arg calls are unchanged.
export type ListFilter = { requesterEmail?: string };

// search takes the raw query plus the same optional role scope as list (spec:
// specs/command-palette.md). One object arg mirrors listPage's shape so the
// router threads scope the same way it does for the list.
export type SearchArgs = { q: string; requesterEmail?: string };

// The opaque keyset cursor lives in cursor.ts; re-exported so existing importers
// (and listPage below) can keep reaching it through the store module.
export { decodeCursor, encodeCursor } from "./cursor.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

export type ListPageResult = { items: Ticket[]; nextCursor: string | null };
export type ListPageArgs = {
  cursor?: string;
  limit: number;
  requesterEmail?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  label?: string;
  unassigned?: boolean;
  unresolved?: boolean;
};

export type AgentRef = { email: string; name: string };

export function createTicketStore(pool: Pool) {
  // Load one ticket (with labels) by id, or null. Shared by getById and by the
  // mutations that re-read the row after an UPDATE to return the wire shape.
  async function loadById(id: string): Promise<Ticket | null> {
    const { rows } = await pool.query<Row>(GET_BY_ID_SQL, [id]);
    return rows[0] ? toTicket(rows[0]) : null;
  }

  // Activity log for a ticket, oldest first (spec: created_at ASC, id ASC).
  // Shared by get() and the standalone listEvents().
  async function loadEvents(ticketId: string): Promise<TicketEvent[]> {
    const { rows } = await pool.query<EventRow>(
      `SELECT id, actor_email, type, payload, created_at
         FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC`,
      [ticketId],
    );
    return rows.map(toEvent);
  }

  return {
    async list(filter?: ListFilter): Promise<Ticket[]> {
      const { rows } = filter?.requesterEmail
        ? await pool.query<Row>(LIST_BY_REQUESTER_SQL, [filter.requesterEmail])
        : await pool.query<Row>(LIST_SQL);
      return rows.map(toTicket);
    },

    // Role-scoped search (spec: specs/command-palette.md). A number-shaped query
    // (SUP-12 / 12) matches t.number exactly; anything else is a case-insensitive
    // subject substring (ILIKE with meta-characters escaped to literals). The
    // optional requesterEmail scope mirrors list(): the router passes the
    // customer's own email so a customer never sees another owner's tickets.
    // Capped at SEARCH_LIMIT rows, list ordering (created_at DESC, id DESC).
    async search({ q, requesterEmail }: SearchArgs): Promise<Ticket[]> {
      const match = NUMBER_QUERY.exec(q);
      const params: unknown[] = [];
      const where: string[] = [];
      if (match) {
        params.push(Number(match[1]));
        where.push(`t.number = $${params.length}`);
      } else {
        params.push(`%${escapeLike(q)}%`);
        where.push(`t.subject ILIKE $${params.length} ESCAPE '\\'`);
      }
      if (requesterEmail) {
        params.push(requesterEmail);
        where.push(`t.requester_email = $${params.length}`);
      }
      params.push(SEARCH_LIMIT);
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM tickets t WHERE ${where.join(" AND ")} ${ORDER} LIMIT $${params.length}`,
        params,
      );
      return rows.map(toTicket);
    },

    getById: loadById,

    // Ticket detail at the store layer: the ticket plus its activity log
    // (created_at ASC). A missing id is NotFoundError so the router maps it to
    // NOT_FOUND without a nullable branch. Messages are a separate store; this
    // get is the ticket + events pair the ticket-model tests pin.
    async get(id: string): Promise<{ ticket: Ticket; events: TicketEvent[] }> {
      const ticket = await loadById(id);
      if (!ticket) throw new NotFoundError(id);
      const events = await loadEvents(id);
      return { ticket, events };
    },

    // Keyset pagination (spec: specs/ticket-model.md): rows strictly after the
    // cursor position under the list ordering (created_at DESC, id DESC), i.e.
    // (created_at, id) < (cursorCreatedAt, cursorId). No OFFSET. Fetches limit+1
    // to decide nextCursor: if a (limit+1)th row exists there is a next page,
    // otherwise nextCursor is null even when exactly limit rows remain.
    async listPage({
      cursor,
      limit,
      requesterEmail,
      status,
      priority,
      label,
      unassigned,
      unresolved,
    }: ListPageArgs): Promise<ListPageResult> {
      const params: unknown[] = [];
      const where: string[] = [];
      if (requesterEmail) {
        params.push(requesterEmail);
        where.push(`t.requester_email = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`t.status = $${params.length}`);
      }
      if (priority) {
        params.push(priority);
        where.push(`t.priority = $${params.length}`);
      }
      if (unassigned) {
        where.push("t.assignee_email IS NULL");
      }
      if (unresolved) {
        where.push("t.status <> 'resolved'");
      }
      // label: an EXISTS over the join to labels by name. A name absent from the
      // catalogue simply matches no ticket (empty page), which the spec wants
      // over an error. The name is a bound param, never interpolated.
      if (label !== undefined) {
        params.push(label);
        where.push(
          `EXISTS (SELECT 1 FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
                    WHERE tl.ticket_id = t.id AND l.name = $${params.length})`,
        );
      }
      if (cursor) {
        const { createdAt, id } = decodeCursor(cursor);
        params.push(createdAt);
        const cAt = params.length;
        params.push(id);
        const cId = params.length;
        where.push(`(t.created_at, t.id) < ($${cAt}::timestamptz, $${cId}::uuid)`);
      }
      params.push(limit + 1);
      const limitParam = params.length;
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM tickets t ${whereSql} ${ORDER} LIMIT $${limitParam}`,
        params,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map(toTicket);
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    },

    // Validate subject/priority at the store boundary (same guarantee the oRPC
    // input layer gives) so a bad subject rejects before touching the DB and
    // the row count stays put. id/number/created_at/updated_at come from the DB
    // defaults via a re-read (loadById) so the returned shape carries labels ([]).
    async create(input: CreateTicketInput): Promise<Ticket> {
      const { subject, priority } = createInput.parse(input);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tickets (subject, status, priority, requester_email)
         VALUES ($1, 'open', $2, $3)
         RETURNING id`,
        [subject, priority, input.requesterEmail],
      );
      const ticket = await loadById(rows[0].id);
      if (!ticket) throw new NotFoundError(rows[0].id);
      return ticket;
    },

    // Same-value change (open→open) is a no-op: no event, no updated_at bump,
    // returns the current ticket successfully (spec). A real change writes the
    // status_changed event and the UPDATE in one transaction so neither can
    // survive without the other. actorEmail is optional so the older 2-arg
    // callers keep working; the router always threads the acting agent, and the
    // "system" fallback only ever appears for a caller that omits it.
    async setStatus(id: string, status: TicketStatus, actorEmail = "system"): Promise<Ticket> {
      const current = await loadById(id);
      if (!current) throw new NotFoundError(id);
      if (current.status === status) return current;
      return withTransaction(pool, async (client) => {
        await client.query(`UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1`, [
          id,
          status,
        ]);
        await insertEvent(client, id, actorEmail, "status_changed", {
          from: current.status,
          to: status,
        });
        const updated = await loadByIdOn(client, id);
        if (!updated) throw new NotFoundError(id);
        return updated;
      });
    },

    // assigneeEmail must be null (unassign) or an existing role='agent' email;
    // anything else is BadRequestError("not an agent"). Same-value (including
    // null→null) is a no-op success. A change writes assignee_changed + bumps
    // updated_at in one transaction.
    async setAssignee(
      id: string,
      assigneeEmail: string | null,
      actorEmail = "system",
    ): Promise<Ticket> {
      const current = await loadById(id);
      if (!current) throw new NotFoundError(id);
      if (assigneeEmail !== null) {
        const { rows } = await pool.query<{ email: string }>(
          `SELECT email FROM users WHERE email = $1 AND role = 'agent'`,
          [assigneeEmail],
        );
        if (rows.length === 0) throw new BadRequestError("not an agent");
      }
      if (current.assigneeEmail === assigneeEmail) return current;
      return withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE tickets SET assignee_email = $2, updated_at = now() WHERE id = $1`,
          [id, assigneeEmail],
        );
        await insertEvent(client, id, actorEmail, "assignee_changed", {
          from: current.assigneeEmail,
          to: assigneeEmail,
        });
        const updated = await loadByIdOn(client, id);
        if (!updated) throw new NotFoundError(id);
        return updated;
      });
    },

    // Full replace of a ticket's labels by name. Duplicates collapse to one; an
    // unknown name is BadRequestError("unknown label"). Set-equal to the current
    // labels is a no-op success. A change swaps the join rows, writes
    // labels_changed (from/to name-sorted), and bumps updated_at in one
    // transaction.
    async setLabels(id: string, labels: string[], actorEmail = "system"): Promise<Ticket> {
      const current = await loadById(id);
      if (!current) throw new NotFoundError(id);
      const wanted = [...new Set(labels)];
      // Resolve names → ids against the catalogue; a name with no id is unknown.
      const { rows: catalog } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM labels`,
      );
      const idByName = new Map(catalog.map((r) => [r.name, r.id]));
      const targetIds: string[] = [];
      for (const name of wanted) {
        const labelId = idByName.get(name);
        if (!labelId) throw new BadRequestError("unknown label");
        targetIds.push(labelId);
      }
      const before = current.labels.map((l) => l.name).sort();
      const after = [...wanted].sort();
      if (sameStringSet(before, after)) return current;
      return withTransaction(pool, async (client) => {
        await client.query(`DELETE FROM ticket_labels WHERE ticket_id = $1`, [id]);
        for (const labelId of targetIds) {
          await client.query(`INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($1, $2)`, [
            id,
            labelId,
          ]);
        }
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
        await insertEvent(client, id, actorEmail, "labels_changed", { from: before, to: after });
        const updated = await loadByIdOn(client, id);
        if (!updated) throw new NotFoundError(id);
        return updated;
      });
    },

    // Bump updated_at after a successful reply (spec: no event, just the touch).
    // Idempotent-safe: a missing id updates nothing, which is fine because the
    // router already gated existence before calling.
    async touch(id: string): Promise<void> {
      await pool.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
    },

    // Post a reply and bump the ticket's updated_at in one transaction (spec:
    // reply は履歴対象外 — no event, just the message + the touch). Returns the
    // created message. A missing parent ticket surfaces as NotFoundError via the
    // FK violation, mirroring the message store's own contract.
    async reply(input: ReplyStoreInput): Promise<Message> {
      const body = replyBodySchema.parse(input.body);
      return withTransaction(pool, async (client) => {
        let message: Message;
        try {
          const { rows } = await client.query<MessageRow>(
            `INSERT INTO messages (ticket_id, author_email, author_role, body)
             VALUES ($1, $2, $3, $4)
             RETURNING id, ticket_id, author_email, author_role, body, created_at`,
            [input.ticketId, input.authorEmail, input.authorRole, body],
          );
          message = toMessage(rows[0]);
        } catch (err) {
          if (err instanceof Error && (err as { code?: string }).code === FK_VIOLATION) {
            throw new NotFoundError(input.ticketId);
          }
          throw err;
        }
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [input.ticketId]);
        return message;
      });
    },

    // Activity log for a ticket, oldest first (spec: created_at ASC, id ASC).
    listEvents: loadEvents,

    // Label catalogue, name-sorted (spec: tickets.labels).
    async labels(): Promise<Label[]> {
      const { rows } = await pool.query<Label>(`SELECT name, color FROM labels ORDER BY name ASC`);
      return rows;
    },

    // Agent directory for the assignee select, email-sorted (spec: tickets.agents).
    async agents(): Promise<AgentRef[]> {
      const { rows } = await pool.query<AgentRef>(
        `SELECT email, name FROM users WHERE role = 'agent' ORDER BY email ASC`,
      );
      return rows;
    },

    // Inbox size (spec: specs/triage.md): unassigned tickets that still need
    // triage — assignee_email IS NULL AND status <> 'resolved'. The router gates
    // this to agents; the store just counts.
    async inboxCount(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM tickets WHERE assignee_email IS NULL AND status <> 'resolved'`,
      );
      return Number(rows[0].count);
    },
  };
}

type EventRow = {
  id: string;
  actor_email: string;
  type: TicketEventType;
  payload: TicketEventPayload;
  created_at: Date;
};

function toEvent(row: EventRow): TicketEvent {
  return {
    id: row.id,
    type: row.type,
    actorEmail: row.actor_email,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

// reply message helpers (mirror messages.ts): boundary body validation, the pg
// FK-violation SQLSTATE for a missing parent ticket, and the Row→Message mapper.
const replyBodySchema = z.string().min(1).max(2000);
const FK_VIOLATION = "23503";

type MessageRow = {
  id: string;
  ticket_id: string;
  author_email: string;
  author_role: MessageRole;
  body: string;
  created_at: Date;
};

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorEmail: row.author_email,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

// A minimal query surface both Pool and a pooled client satisfy, so the loadById
// re-read can run either on the pool or inside a transaction's client.
type Queryable = { query: Pool["query"] };

async function loadByIdOn(client: Queryable, id: string): Promise<Ticket | null> {
  const { rows } = await client.query<Row>(GET_BY_ID_SQL, [id]);
  return rows[0] ? toTicket(rows[0]) : null;
}

async function insertEvent(
  client: Queryable,
  ticketId: string,
  actorEmail: string,
  type: TicketEventType,
  payload: TicketEventPayload,
): Promise<void> {
  await client.query(
    `INSERT INTO ticket_events (ticket_id, actor_email, type, payload)
     VALUES ($1, $2, $3, $4)`,
    [ticketId, actorEmail, type, JSON.stringify(payload)],
  );
}

// Run fn on a dedicated pooled client wrapped in BEGIN/COMMIT so the event
// insert and the body UPDATE commit together (spec: 同一トランザクション). Any
// throw rolls back and releases the client; the error propagates unchanged.
async function withTransaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client as unknown as Queryable);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export type TicketStore = ReturnType<typeof createTicketStore>;
