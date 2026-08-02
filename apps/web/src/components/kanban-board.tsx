import { Link } from "@tanstack/react-router";
import { type DragEvent, useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import type { Ticket, TicketStatus } from "@/lib/tickets";
import { cn } from "@/lib/utils";

const COLUMNS: { status: TicketStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In progress" },
  { status: "resolved", label: "Resolved" },
];

// The ticket id travels through the browser's own drag channel as text/plain, so
// dragstart writes it and drop reads it — the same DataTransfer instance the BM
// test threads through its synthetic DragEvents (kanban.test.tsx dragCardTo).
const DRAG_MIME = "text/plain";

// HTML5-native kanban board (spec: 外部D&Dライブラリ禁止). The board owns the
// column assignment as local state so a successful drop can move a card
// optimistically-after-confirm: onSetStatus is awaited, and only its resolution
// commits the move (spec:「成功で列間移動を確定」). A rejection leaves the card
// in place and raises board-error.
export function KanbanBoard({
  tickets,
  onSetStatus,
}: {
  tickets: Ticket[];
  onSetStatus: (id: string, status: TicketStatus) => Promise<void>;
}) {
  const [error, setError] = useState(false);
  // Optimistic status overrides keyed by ticket id. A drop commits after
  // onSetStatus resolves and must not be reverted by a list refetch that raced
  // ahead of the write: the board's list query is invalidated by every realtime
  // ticket event — including changes this board did not make (shared E2E
  // database / other agents) — so an unrelated event mid-drop can deliver a
  // pre-move list. Rendering server tickets directly and blindly adopting each
  // refetch would flicker the moved card back to its old column. The override
  // is dropped once the server list reflects it (or the ticket is gone).
  const [pending, setPending] = useState<Map<string, TicketStatus>>(() => new Map());

  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev;
      const serverStatus = new Map(tickets.map((t) => [t.id, t.status]));
      const next = new Map(prev);
      for (const [id, status] of prev) {
        const current = serverStatus.get(id);
        if (current === undefined || current === status) next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [tickets]);

  const items = tickets.map((t) => {
    const override = pending.get(t.id);
    return override && override !== t.status ? { ...t, status: override } : t;
  });

  const onDrop = async (event: DragEvent, status: TicketStatus) => {
    event.preventDefault();
    const id = event.dataTransfer.getData(DRAG_MIME);
    const ticket = items.find((t) => t.id === id);
    // Ignore drops that carry no id or land on the card's current column.
    if (!ticket || ticket.status === status) return;

    try {
      await onSetStatus(id, status);
      setError(false);
      setPending((prev) => new Map(prev).set(id, status));
    } catch {
      setError(true);
    }
  };

  return (
    // 列(li)がドロップ対象なので、レーンはメインペインの残り全高まで
    // 伸ばす。カード数ぶんの高さしか無いと、カード下の広い空き領域が
    // li の外=ドロップ不能になり「カードに重ねないと移動できない」体験になる。
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error && (
        <p data-testid="board-error" role="alert" className="text-sm text-destructive">
          Failed to update ticket status.
        </p>
      )}
      <ul
        data-testid="kanban-board"
        className="grid flex-1 auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3"
      >
        {COLUMNS.map((column) => {
          const cards = items.filter((t) => t.status === column.status);
          return (
            <li
              key={column.status}
              data-testid={`kanban-column-${column.status}`}
              // preventDefault on dragover marks the column a valid drop target
              // (without it the browser rejects the drop); the BM test fires a
              // cancelable dragover to exercise exactly this. dropEffect must be
              // set explicitly — some browsers resolve it to "none" otherwise and
              // reject the drop even after preventDefault.
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => onDrop(e, column.status)}
              className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface-1 p-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium tracking-tight">{column.label}</h2>
                <span
                  data-testid="column-count"
                  className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-muted"
                >
                  {cards.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {cards.map((ticket) => (
                  <KanbanCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// feature-card (APP_DESIGN): surface-1 fill, hairline border, rounded-lg. The
// draggable tile lifts to surface-2 while dragging (spec:「ドラッグ中は surface-2
// リフト」). The subject is a router Link in the TicketList idiom.
function KanbanCard({ ticket }: { ticket: Ticket }) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      data-testid="kanban-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, ticket.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-hairline bg-surface-1 p-3",
        dragging && "bg-surface-2",
      )}
    >
      <Link
        to="/tickets/$id"
        params={{ id: ticket.id }}
        className="truncate text-sm text-card-foreground transition-colors hover:text-primary-hover"
      >
        {ticket.subject}
      </Link>
      <div className="flex items-center gap-2">
        <StatusBadge status={ticket.status} />
        <span className="text-xs text-ink-subtle capitalize">{ticket.priority}</span>
      </div>
    </div>
  );
}
