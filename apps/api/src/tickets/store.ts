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

export class TicketStore {
  private tickets: Ticket[];

  constructor() {
    this.tickets = SEEDS.map((seed) => ({ id: crypto.randomUUID(), ...seed }));
  }

  // createdAt descending: newest first.
  list(): Ticket[] {
    return [...this.tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input: { subject: string; priority: TicketPriority }): Ticket {
    const ticket: Ticket = {
      id: crypto.randomUUID(),
      subject: input.subject,
      status: "open",
      priority: input.priority,
      requesterEmail: "customer@example.com",
      createdAt: new Date().toISOString(),
    };
    this.tickets.push(ticket);
    return ticket;
  }

  setStatus(id: string, status: TicketStatus): Ticket | undefined {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) return undefined;
    ticket.status = status;
    return ticket;
  }
}

// Single process-wide store: the in-memory tickets survive across requests for
// the lifetime of the dev/E2E server.
export const ticketStore = new TicketStore();
