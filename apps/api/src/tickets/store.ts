import type { Pool } from "../db.js";
import { createInput } from "./schema.js";

export type TicketStatus = "open" | "in_progress" | "resolved";
export type TicketPriority = "low" | "medium" | "high";

export type Ticket = {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterEmail: string;
  createdAt: string;
};

export type CreateTicketInput = {
  subject: string;
  priority: TicketPriority;
  requesterEmail: string;
};

// Thrown by setStatus when no row matches the id, so the router can map it to an
// oRPC NOT_FOUND without string-matching an error message.
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`NOT_FOUND: ticket ${id}`);
    this.name = "NotFoundError";
  }
}

// Column order matches the SELECT list; createdAt is normalised to an ISO
// string here so the wire shape stays identical to the old in-memory store
// (pg returns timestamptz as a Date).
type Row = {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requester_email: string;
  created_at: Date;
};

function toTicket(row: Row): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    requesterEmail: row.requester_email,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = "id, subject, status, priority, requester_email, created_at";

// Deterministic order: created_at DESC, then id DESC to break ties (seeds share
// no timestamp, but created rows land at now() and could collide).
const LIST_SQL = `SELECT ${COLUMNS} FROM tickets ORDER BY created_at DESC, id DESC`;

export function createTicketStore(pool: Pool) {
  return {
    async list(): Promise<Ticket[]> {
      const { rows } = await pool.query<Row>(LIST_SQL);
      return rows.map(toTicket);
    },

    // Validate subject/priority at the store boundary (same guarantee the oRPC
    // input layer gives) so a bad subject rejects before touching the DB and
    // the row count stays put. id + created_at come from the DB defaults
    // (uuidv7(), now()) via RETURNING — the app never generates the id.
    async create(input: CreateTicketInput): Promise<Ticket> {
      const { subject, priority } = createInput.parse(input);
      const { rows } = await pool.query<Row>(
        `INSERT INTO tickets (subject, status, priority, requester_email)
         VALUES ($1, 'open', $2, $3)
         RETURNING ${COLUMNS}`,
        [subject, priority, input.requesterEmail],
      );
      return toTicket(rows[0]);
    },

    async setStatus(id: string, status: TicketStatus): Promise<Ticket> {
      const { rows } = await pool.query<Row>(
        `UPDATE tickets SET status = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, status],
      );
      if (rows.length === 0) {
        throw new NotFoundError(id);
      }
      return toTicket(rows[0]);
    },
  };
}

export type TicketStore = ReturnType<typeof createTicketStore>;
