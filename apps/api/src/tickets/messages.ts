import { z } from "zod";
import type { Pool } from "../db.js";
import { NotFoundError } from "./store.js";

export type MessageRole = "customer" | "agent";

export type Message = {
  id: string;
  ticketId: string;
  authorEmail: string;
  authorRole: MessageRole;
  body: string;
  createdAt: string;
};

export type CreateMessageInput = {
  ticketId: string;
  authorEmail: string;
  authorRole: MessageRole;
  body: string;
};

// Store-boundary validation mirrors the messages CHECK constraint (and the
// replyInput zod at the router): reject an out-of-range body before touching
// the DB so the rejection is a plain error, not a raw pg CHECK violation.
const bodySchema = z.string().min(1).max(2000);

// created_at is normalised to an ISO string here (pg returns timestamptz as a
// Date) so the wire shape matches the Message type the UI consumes.
type Row = {
  id: string;
  ticket_id: string;
  author_email: string;
  author_role: MessageRole;
  body: string;
  created_at: Date;
};

function toMessage(row: Row): Message {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorEmail: row.author_email,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = "id, ticket_id, author_email, author_role, body, created_at";

// Deterministic thread order: created_at ASC, then id ASC to break ties (v7 ids
// are chronological, so a reply landing at the same now() still sorts last).
const LIST_SQL = `SELECT ${COLUMNS} FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC`;

// pg SQLSTATE for foreign_key_violation — a create against a missing ticket.
const FK_VIOLATION = "23503";

export function createMessageStore(pool: Pool) {
  return {
    async listByTicket(ticketId: string): Promise<Message[]> {
      const { rows } = await pool.query<Row>(LIST_SQL, [ticketId]);
      return rows.map(toMessage);
    },

    // id + created_at come from the DB defaults (uuidv7(), now()) via RETURNING.
    // A missing parent ticket surfaces as an FK violation, remapped to the
    // shared NotFoundError so the router maps it to NOT_FOUND without string-
    // matching. Nothing is persisted on that path (the single INSERT fails).
    async create(input: CreateMessageInput): Promise<Message> {
      const body = bodySchema.parse(input.body);
      try {
        const { rows } = await pool.query<Row>(
          `INSERT INTO messages (ticket_id, author_email, author_role, body)
           VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
          [input.ticketId, input.authorEmail, input.authorRole, body],
        );
        return toMessage(rows[0]);
      } catch (err) {
        if (err instanceof Error && (err as { code?: string }).code === FK_VIOLATION) {
          throw new NotFoundError(input.ticketId);
        }
        throw err;
      }
    },
  };
}

export type MessageStore = ReturnType<typeof createMessageStore>;
