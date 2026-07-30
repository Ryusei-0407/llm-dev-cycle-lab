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
