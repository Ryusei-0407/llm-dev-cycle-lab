import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type TicketStatus = "open" | "in_progress" | "resolved";

const LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

// status-badge (APP_DESIGN): surface-2 fill, ink-muted text, caption type, pill
// radius, 2px 8px padding. Resolved leans on the single semantic accent.
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
        "inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-muted",
        status === "resolved" && "text-success",
        className,
      )}
      {...props}
    >
      {LABELS[status]}
    </span>
  );
}
