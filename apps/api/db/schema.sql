-- tickets schema (spec: specs/database.md). Requires PostgreSQL 18 for the
-- native uuidv7() default: chronologically ordered UUIDs, so ids sort by
-- creation without a separate sequence. Dropped + recreated by test-db.mjs
-- (applySchemaAndSeed) for idempotent per-run resets.
-- messages drops first: it references tickets, so it must go before the parent
-- (DROP … CASCADE would work too, but explicit child-first keeps the intent).
-- sessions references users, so it drops before users for the same reason.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS tickets;

-- auth (spec: specs/auth-db.md). users holds credentials (scrypt "salt:hexhash"
-- in password_hash); only the public shape (id/email/name/role) ever leaves the
-- API. sessions is the shared sid → user_id store that replaces the old
-- in-memory Map, so a login survives a process restart and any app instance
-- resolves the same sid. id is an explicit uuid (seed pins fixed v7 literals);
-- unlike tickets it does not default to uuidv7() — users are seeded, not created
-- at runtime.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('agent', 'customer')),
  password_hash text NOT NULL, -- scrypt: "salt:hexhash"
  created_at timestamptz NOT NULL DEFAULT now()
);

-- sessions: sid → user_id. sid is a runtime crypto.randomUUID() (v4 — an opaque
-- secret token, no ordering needed), so no uuidv7() default. ON DELETE CASCADE
-- so removing a user takes their sessions with it.
CREATE TABLE sessions (
  sid uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
