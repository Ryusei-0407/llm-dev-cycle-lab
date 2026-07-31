// Front-end ticket types. Deliberately a plain re-definition rather than a
// re-export of the API types: the web layer owns its own view model so the
// UI stays decoupled from the server module graph.
export type TicketStatus = "open" | "in_progress" | "resolved";
export type TicketPriority = "low" | "medium" | "high";

export type Label = { name: string; color: string };

// ticket-model added number / assigneeEmail / labels / updatedAt. The server
// always sends them, but they are optional on this view-model so pre-existing
// fixtures (kanban/status component tests) that only need the core fields stay
// valid; the UI reads them defensively (labels ?? [], assigneeEmail ?? null).
export type Ticket = {
  id: string;
  number?: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterEmail: string;
  assigneeEmail?: string | null;
  labels?: Label[];
  createdAt: string;
  updatedAt?: string;
};

export type MessageRole = "customer" | "agent";

export type Message = {
  id: string;
  ticketId: string;
  authorEmail: string;
  authorRole: MessageRole;
  body: string;
  createdAt: string;
};

// Activity log entry (spec: specs/ticket-model.md). payload is a discriminated
// union keyed by type; the detail view renders each type as a fixed phrase.
export type TicketEvent = {
  id: string;
  type: "status_changed" | "assignee_changed" | "labels_changed";
  actorEmail: string;
  payload:
    | { from: TicketStatus; to: TicketStatus }
    | { from: string | null; to: string | null }
    | { from: string[]; to: string[] };
  createdAt: string;
};
