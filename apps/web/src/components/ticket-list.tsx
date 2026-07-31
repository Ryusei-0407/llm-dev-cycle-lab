import { Link } from "@tanstack/react-router";
import { StatusBadge } from "@/components/status-badge";
import type { Ticket, TicketStatus } from "@/lib/tickets";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

// Assignee display (spec: specs/ticket-model.md 一覧). The row shows the local
// part of the assignee email (agent@example.com → agent); unassigned renders the
// en-dash placeholder.
function assigneeLabel(email: string | null): string {
  if (!email) return "–";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export function TicketList({
  tickets,
  onStatusChange,
  showStatusControl = true,
}: {
  tickets: Ticket[];
  onStatusChange: (id: string, status: TicketStatus) => void;
  // Status change is an agent-only control; a customer session hides it
  // (specs/customer-portal.md). Defaults to shown so the component keeps its
  // agent behavior wherever the flag isn't passed.
  showStatusControl?: boolean;
}) {
  return (
    <ul data-testid="ticket-list" className="flex flex-col gap-2">
      {tickets.map((ticket) => (
        <li
          key={ticket.id}
          data-testid="ticket-row"
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          {/* A semantic router Link (renders <a role=link>): keyboard-focusable
              and it navigates in-app (SPA) rather than a full-document load.
              Mounting TicketList now requires a router context, so
              ticket-status.test.tsx wraps it in a memory router. */}
          <span data-testid="ticket-number" className="text-xs text-ink-subtle tabular-nums">
            SUP-{ticket.number}
          </span>
          <Link
            data-testid="ticket-link"
            to="/tickets/$id"
            params={{ id: ticket.id }}
            className="flex-1 truncate text-sm text-card-foreground transition-colors hover:text-primary-hover"
          >
            {ticket.subject}
          </Link>
          <span data-testid="ticket-labels" className="flex items-center gap-1">
            {(ticket.labels ?? []).map((label) => (
              <span
                key={label.name}
                data-testid="ticket-label"
                className="rounded px-1.5 py-0.5 text-xs font-medium text-white"
                style={{ backgroundColor: label.color }}
              >
                {label.name}
              </span>
            ))}
          </span>
          <span data-testid="ticket-assignee" className="text-xs text-ink-subtle">
            {assigneeLabel(ticket.assigneeEmail ?? null)}
          </span>
          <StatusBadge status={ticket.status} />
          <span className="text-xs text-ink-subtle capitalize">{ticket.priority}</span>
          {showStatusControl && (
            <select
              data-testid="ticket-status-select"
              aria-label={`Status for ${ticket.subject}`}
              value={ticket.status}
              onChange={(e) => onStatusChange(ticket.id, e.target.value as TicketStatus)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </li>
      ))}
    </ul>
  );
}
