import type { Message, TicketEvent } from "@/lib/tickets";
import { cn } from "@/lib/utils";

// The conversation thread (spec: specs/ticket-detail.md). Rendered as a
// semantic list so the E2E can assert structure by role (list/listitem) rather
// than copy. Agent messages lean right, customer left — the Linear-flavoured
// role differentiation; the author line shows the email (the E2E asserts the
// posted reply is authored by agent@example.com).
//
// ticket-model merges activity events into the same timeline (spec:
// specs/ticket-model.md 詳細): messages and events are interleaved by created_at
// so a status/assignee/label change reads inline with the conversation.

// Fixed, test-anchored phrasing for each event type. status/assignee render the
// raw values (open/in_progress/resolved, email); a null assignee is 未割り当て;
// labels_changed lists the resulting names or なし when cleared.
function eventText(event: TicketEvent): string {
  switch (event.type) {
    case "status_changed": {
      const { from, to } = event.payload as { from: string; to: string };
      return `状態: ${from} → ${to}`;
    }
    case "assignee_changed": {
      const { from, to } = event.payload as { from: string | null; to: string | null };
      return `担当者: ${from ?? "未割り当て"} → ${to ?? "未割り当て"}`;
    }
    case "labels_changed": {
      const { to } = event.payload as { to: string[] };
      return `ラベル: ${to.length > 0 ? to.join(", ") : "なし"}`;
    }
  }
}

type TimelineItem =
  | { kind: "message"; at: string; id: string; message: Message }
  | { kind: "event"; at: string; id: string; event: TicketEvent };

// Merge messages + events into one created_at-ascending timeline. Ties keep a
// stable order (id ASC) so the render is deterministic — v7 ids are
// chronological, matching the store's created_at ASC, id ASC contract.
function mergeTimeline(messages: Message[], events: TicketEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.createdAt, id: m.id, message: m })),
    ...events.map((e) => ({ kind: "event" as const, at: e.createdAt, id: e.id, event: e })),
  ];
  return items.sort((a, b) =>
    a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at),
  );
}

export function MessageThread({
  messages,
  events = [],
}: {
  messages: Message[];
  events?: TicketEvent[];
}) {
  const timeline = mergeTimeline(messages, events);
  return (
    <ul data-testid="message-thread" className="flex flex-col gap-3">
      {timeline.map((item) => {
        if (item.kind === "event") {
          return (
            <li
              key={item.id}
              data-testid="ticket-event"
              className="self-center text-xs text-ink-subtle"
            >
              {eventText(item.event)}
            </li>
          );
        }
        const message = item.message;
        const isAgent = message.authorRole === "agent";
        return (
          <li
            key={item.id}
            data-testid="message-item"
            className={cn("flex flex-col gap-1", isAgent ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "max-w-[80%] rounded-lg border border-hairline px-4 py-2",
                isAgent ? "bg-surface-2" : "bg-surface-1",
              )}
            >
              <span data-testid="message-author" className="mb-0.5 block text-xs text-ink-subtle">
                {message.authorEmail}
              </span>
              <p className="text-sm whitespace-pre-wrap text-ink">{message.body}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
