import { createInput, type SetStatusInput } from "./schema.js";

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

// Deterministic seeds (spec order/values). createdAt is authored ascending so
// the newest seed (Feature request) sorts first under the createdAt-desc list.
const SEEDS: Omit<Ticket, "id">[] = [
  {
    subject: "Cannot login to dashboard",
    status: "open",
    priority: "high",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    subject: "Billing question",
    status: "in_progress",
    priority: "medium",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    subject: "Feature request: dark mode",
    status: "resolved",
    priority: "low",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-03T00:00:00.000Z",
  },
];

class TicketStore {
  private tickets: Ticket[];

  constructor() {
    this.tickets = SEEDS.map((seed) => ({ id: crypto.randomUUID(), ...seed }));
  }

  // createdAt descending: newest first.
  list(): Ticket[] {
    return [...this.tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input: { subject: string; priority: TicketPriority }): Ticket {
    // Validate at the store boundary so direct callers (unit tests) get the same
    // guarantees the tRPC input layer enforces.
    const parsed = createInput.parse(input);
    const ticket: Ticket = {
      id: crypto.randomUUID(),
      subject: parsed.subject,
      status: "open",
      priority: parsed.priority,
      requesterEmail: "customer@example.com",
      createdAt: new Date().toISOString(),
    };
    this.tickets.push(ticket);
    return ticket;
  }

  setStatus({ id, status }: SetStatusInput): Ticket {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) {
      throw new Error(`NOT_FOUND: ticket ${id}`);
    }
    ticket.status = status;
    return ticket;
  }
}

// Factory: each call yields an isolated in-memory store (unit tests rely on
// this for a clean seed per case).
export function createTicketStore(): TicketStore {
  return new TicketStore();
}

// Single process-wide store: the in-memory tickets survive across requests for
// the lifetime of the dev/E2E server.
export const ticketStore = createTicketStore();
