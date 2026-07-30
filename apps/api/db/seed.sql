-- Deterministic auth seed (spec: specs/auth-db.md). Fixed v7 id literals so the
-- session lane's foreign keys and the HTTP tests' user shapes are stable.
-- password_hash is node:crypto scryptSync(password, salt, 64) rendered as
-- "salt:hexhash"; the plaintexts (agent-pass / customer-pass) are what
-- verifyCredentials accepts, asserted by auth-route.test.ts and auth-db.test.ts.
-- salt is the fixed 'llmlab-auth-v1' string, so the hashes below are
-- reproducible: scryptSync('agent-pass', 'llmlab-auth-v1', 64).toString('hex').
INSERT INTO users (id, email, name, role, password_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'agent@example.com',    'Aki Agent',     'agent',    'llmlab-auth-v1:89dfcf4cd69f610a807f88489444236fa812e491190d94f50f7a48beb66982dc239694e820c5758eb3ae90dfb68b6495fdc1a349dc68b70da55986aa0eae0bc7'),
  ('00000000-0000-7000-8000-0000000000a2', 'customer@example.com', 'Chika Customer', 'customer', 'llmlab-auth-v1:a7f22e0d3511bef9b6b005331864e2d6dca0f8ab108c6147a2ef0b3608826bd2f16f7efcd74442613b1cc6a2e8b4c92d8d9ccfcef66eda3299d726550f5eb5b4');

-- Deterministic seed (spec: specs/tickets.md values). ids are fixed UUID v7
-- literals (version nibble '7', variant '8') and created_at is fixed ascending
-- so list() (created_at DESC, id DESC) is stable: "Feature request" first,
-- "Cannot login" last. Explicit ids/timestamps override the table defaults so
-- the ordering never depends on wall-clock insert time.
INSERT INTO tickets (id, subject, status, priority, requester_email, created_at) VALUES
  ('00000000-0000-7000-8000-000000000001', 'Cannot login to dashboard', 'open',        'high',   'customer@example.com', '2026-01-01T00:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000002', 'Billing question',          'in_progress', 'medium', 'customer@example.com', '2026-01-02T00:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000003', 'Feature request: dark mode','resolved',    'low',    'customer@example.com', '2026-01-03T00:00:00.000Z');

-- Deterministic message seeds (spec: specs/ticket-detail.md シード). Fixed v7 ids
-- and ascending created_at so listByTicket (created_at ASC, id ASC) is stable.
-- ticket 1 carries a customer→agent exchange; ticket 2 a single customer note.
-- The exact wording is asserted by the store tests (invalid credentials /
-- changed your password), so keep it verbatim.
INSERT INTO messages (id, ticket_id, author_email, author_role, body, created_at) VALUES
  ('00000000-0000-7000-8000-000000000101', '00000000-0000-7000-8000-000000000001', 'customer@example.com', 'customer', 'I can''t sign in to the dashboard since this morning. It says invalid credentials.', '2026-01-01T01:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000102', '00000000-0000-7000-8000-000000000001', 'agent@example.com',    'agent',    'Thanks for the report — could you tell me if you recently changed your password?',   '2026-01-01T02:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000103', '00000000-0000-7000-8000-000000000002', 'customer@example.com', 'customer', 'Our invoice for June seems to double-count seats.',                                  '2026-01-02T01:00:00.000Z');
