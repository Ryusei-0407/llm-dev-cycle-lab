import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { StatusBadge } from "@/components/status-badge";
import type { Ticket, TicketStatus } from "@/lib/tickets";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

// Fixed row height (spec: 行高48px固定). The virtualizer estimates every row at
// this and the row element pins itself to it (h-12), so no per-row measurement
// is needed and the absolute offsets stay exact.
const ROW_HEIGHT = 48;

// Prefetch trigger (spec): fetch the next page once the visible tail reaches
// 末尾-5行. Read off the virtualizer's last virtual index against the loaded
// count so it fires regardless of scroll speed.
const END_REACHED_THRESHOLD = 5;

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
  onEndReached,
  height,
}: {
  tickets: Ticket[];
  onStatusChange: (id: string, status: TicketStatus) => void;
  // Status change is an agent-only control; a customer session hides it
  // (specs/customer-portal.md). Defaults to shown so the component keeps its
  // agent behavior wherever the flag isn't passed.
  showStatusControl?: boolean;
  // Fired each time the visible tail crosses 末尾-5行 (spec); the list route
  // wires this to fetch the next infinite page.
  onEndReached?: () => void;
  // Scroll-region height in px. When omitted the scroll element grows to its
  // content, so the visible window spans every row — this is how the component
  // tests (which mount without a height) still render all rows.
  height?: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: tickets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1;

  useEffect(() => {
    if (!onEndReached) return;
    if (tickets.length > 0 && lastIndex >= tickets.length - 1 - END_REACHED_THRESHOLD) {
      onEndReached();
    }
  }, [onEndReached, lastIndex, tickets.length]);

  return (
    <div
      ref={scrollRef}
      // The scroll element owns the virtual window (and the ticket-list testid —
      // tests treat ticket-list as the scrollable region). A fixed height
      // constrains it so only the visible rows mount; without one it sizes to
      // its content (the inner ul's total height) so clientHeight spans every
      // row and the whole list renders — the fallback the component tests rely on.
      data-testid="ticket-list"
      style={height != null ? { height, overflow: "auto" } : undefined}
    >
      <ul
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        className="flex flex-col"
      >
        {virtualItems.map((virtualRow) => {
          const ticket = tickets[virtualRow.index];
          return (
            <li
              key={ticket.id}
              data-testid="ticket-row"
              // 固定幅カラムのグリッド(PC 前提)。flex の内容依存幅だと文字列長で
              // 各カラムの横位置が行ごとに揺れるため、subject 以外は幅を固定して
              // 縦のラインを揃える。customer 表示ではセレクト列は空のまま保持し、
              // ロール差でレイアウトが変わらないようにする。仮想化で各行は absolute
              // 配置になるため、グリッド定義は行要素側に残す。
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="grid h-12 grid-cols-[3.5rem_minmax(0,1fr)_9rem_5.5rem_6.5rem_4.5rem_8.5rem] items-center gap-3 rounded-lg border border-border bg-card px-4"
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
                className="truncate text-sm text-card-foreground transition-colors hover:text-primary-hover"
              >
                {ticket.subject}
              </Link>
              <span data-testid="ticket-labels" className="flex items-center gap-1 overflow-hidden">
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
              <span data-testid="ticket-assignee" className="truncate text-xs text-ink-subtle">
                {assigneeLabel(ticket.assigneeEmail ?? null)}
              </span>
              <span>
                <StatusBadge status={ticket.status} />
              </span>
              <span className="text-xs text-ink-subtle capitalize">{ticket.priority}</span>
              {showStatusControl ? (
                <select
                  data-testid="ticket-status-select"
                  aria-label={`Status for ${ticket.subject}`}
                  value={ticket.status}
                  onChange={(e) => onStatusChange(ticket.id, e.target.value as TicketStatus)}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
