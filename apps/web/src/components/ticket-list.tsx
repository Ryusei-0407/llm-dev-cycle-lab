import { StatusBadge, type TicketStatus } from "@/components/status-badge";

export type TicketPriority = "low" | "medium" | "high";

export type Ticket = {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterEmail: string;
  createdAt: string;
};

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
          <span className="flex-1 truncate text-sm text-card-foreground">{ticket.subject}</span>
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
