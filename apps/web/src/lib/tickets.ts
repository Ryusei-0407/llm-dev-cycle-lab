// Front-end ticket types. Deliberately a plain re-definition rather than a
// re-export of the API types: the web layer owns its own view model so the
// UI stays decoupled from the server module graph.
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
