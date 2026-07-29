-- tickets schema (spec: specs/database.md). Requires PostgreSQL 18 for the
-- native uuidv7() default: chronologically ordered UUIDs, so ids sort by
-- creation without a separate sequence. Dropped + recreated by test-db.mjs
-- (applySchemaAndSeed) for idempotent per-run resets.
DROP TABLE IF EXISTS tickets;

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved')),
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  requester_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
