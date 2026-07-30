import type { Message } from "@/lib/tickets";
import { cn } from "@/lib/utils";

// The conversation thread (spec: specs/ticket-detail.md). Rendered as a
// semantic list so the E2E can assert structure by role (list/listitem) rather
// than copy. Agent messages lean right, customer left — the Linear-flavoured
// role differentiation; the author line shows the email (the E2E asserts the
// posted reply is authored by agent@example.com).
export function MessageThread({ messages }: { messages: Message[] }) {
  return (
    <ul data-testid="message-thread" className="flex flex-col gap-3">
      {messages.map((message) => {
        const isAgent = message.authorRole === "agent";
        return (
          <li
            key={message.id}
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
