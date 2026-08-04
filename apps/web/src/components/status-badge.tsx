import type { ComponentProps } from "react";
import type { TicketStatus } from "@/lib/tickets";
import { cn } from "@/lib/utils";

const LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

// Status glyph (design mock 01 .st): open = hollow ring, in_progress = half-filled
// warn disc, resolved = filled success disc with a check. Marked aria-hidden — the
// badge text already names the status, so the icon is decoration for assistive tech.
function StatusIcon({ status }: { status: TicketStatus }) {
  if (status === "resolved") {
    return (
      <svg viewBox="0 0 13 13" className="size-3 shrink-0" aria-hidden>
        <circle cx="6.5" cy="6.5" r="5.75" fill="#27a644" />
        <path
          d="M4 6.8 5.9 8.7 9 4.6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg viewBox="0 0 13 13" className="size-3 shrink-0" aria-hidden>
        <circle cx="6.5" cy="6.5" r="5.75" fill="none" stroke="var(--warn)" strokeWidth="1.5" />
        <path d="M6.5 6.5 V1.6 A4.9 4.9 0 0 1 6.5 11.4 Z" fill="var(--warn)" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 13 13" className="size-3 shrink-0" aria-hidden>
      <circle cx="6.5" cy="6.5" r="5.75" fill="none" stroke="#8a8f98" strokeWidth="1.5" />
    </svg>
  );
}

// status-badge (APP_DESIGN): surface-2 fill, ink-muted text, caption type, pill
// radius, 2px 8px padding. Resolved leans on the single semantic accent. A status
// glyph (mock 01) sits before the label.
export function StatusBadge({
  status,
  className,
  ...props
}: { status: TicketStatus } & ComponentProps<"span">) {
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-muted",
        status === "resolved" && "text-success",
        className,
      )}
      {...props}
    >
      <StatusIcon status={status} />
      {LABELS[status]}
    </span>
  );
}
