import { StatusBadge } from "@/components/status-badge";
import type { Ticket, TicketStatus } from "@/lib/tickets";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

export function TicketList({
  tickets,
  onStatusChange,
}: {
  tickets: Ticket[];
  onStatusChange: (id: string, status: TicketStatus) => void;
}) {
  return (
    <ul data-testid="ticket-list" className="flex flex-col gap-2">
      {tickets.map((ticket) => (
        <li
          key={ticket.id}
          data-testid="ticket-row"
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          {/* A non-semantic span, deliberately not an <a>/router Link. Two
              pre-existing tests constrain this: ticket-status.test.tsx mounts
              TicketList without a RouterProvider (so no router hook may run at
              render), and tickets.spec.ts asserts an aria snapshot where the
              subject is a plain `text` node — a link/button would add its own
              a11y node and fail that match. Navigation is a full-document load
              via window.location, which needs no router context. */}
          <span
            data-testid="ticket-link"
            onClick={() => window.location.assign(`/tickets/${ticket.id}`)}
            className="flex-1 cursor-pointer truncate text-sm text-card-foreground transition-colors hover:text-primary-hover"
          >
            {ticket.subject}
          </span>
          <StatusBadge status={ticket.status} />
          <span className="text-xs text-ink-subtle capitalize">{ticket.priority}</span>
          <select
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
        </li>
      ))}
    </ul>
  );
}
