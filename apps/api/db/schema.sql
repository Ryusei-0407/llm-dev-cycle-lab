-- tickets schema (spec: specs/database.md). Requires PostgreSQL 18 for the
-- native uuidv7() default: chronologically ordered UUIDs, so ids sort by
-- creation without a separate sequence. Dropped + recreated by test-db.mjs
-- (applySchemaAndSeed) for idempotent per-run resets.
-- messages drops first: it references tickets, so it must go before the parent
-- (DROP … CASCADE would work too, but explicit child-first keeps the intent).
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS tickets;

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved')),
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  requester_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- messages: the conversation thread on a ticket (spec: specs/ticket-detail.md).
-- FK ON DELETE CASCADE so a deleted ticket takes its thread with it; CHECKs
-- mirror the zod input layer (author_role enum, body 1..2000) so a raw INSERT
-- that bypasses zod still can't write an invalid row.
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_email text NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('customer', 'agent')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
