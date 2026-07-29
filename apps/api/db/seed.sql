-- Deterministic seed (spec: specs/tickets.md values). ids are fixed UUID v7
-- literals (version nibble '7', variant '8') and created_at is fixed ascending
-- so list() (created_at DESC, id DESC) is stable: "Feature request" first,
-- "Cannot login" last. Explicit ids/timestamps override the table defaults so
-- the ordering never depends on wall-clock insert time.
INSERT INTO tickets (id, subject, status, priority, requester_email, created_at) VALUES
  ('00000000-0000-7000-8000-000000000001', 'Cannot login to dashboard', 'open',        'high',   'customer@example.com', '2026-01-01T00:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000002', 'Billing question',          'in_progress', 'medium', 'customer@example.com', '2026-01-02T00:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000003', 'Feature request: dark mode','resolved',    'low',    'customer@example.com', '2026-01-03T00:00:00.000Z');
