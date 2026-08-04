import { useChat } from "@tanstack/ai-react";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";

// reply-draft (spec: specs/reply-draft.md). Streams an LLM reply draft from
// POST /api/tickets/draft over Server-Sent Events using @tanstack/ai-react's
// useChat, and hands the finished text to the parent so it lands in the Reply
// textarea. The panel owns only the streaming lifecycle; the reply body state
// lives on the ticket detail route so "Use draft" can overwrite it.

// The assistant text is the join of every `text` part on the latest assistant
// message (useChat appends deltas into these parts as the stream arrives).
function assistantText(messages: ReturnType<typeof useChat>["messages"]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return "";
  return last.parts
    .filter((p): p is { type: "text"; content: string } => p.type === "text")
    .map((p) => p.content)
    .join("");
}

export function DraftPanel({
  ticketId,
  onUseDraft,
}: {
  ticketId: string;
  onUseDraft: (text: string) => void;
}) {
  // The server ignores the wire `messages` and reads the ticket by id, so the
  // id rides along as request body data (forwardedProps on the wire). credentials
  // "include" carries the session cookie (the route is auth-gated). Memoised so
  // the ChatClient instance is stable across renders (a new connection would
  // otherwise reset the hook — see UseChatOptions note).
  const connection = useMemo(
    () =>
      fetchServerSentEvents("/api/tickets/draft", {
        credentials: "include",
        body: { ticketId },
      }),
    [ticketId],
  );

  const { messages, sendMessage, isLoading, error } = useChat({ connection });

  const draft = assistantText(messages);
  // sendMessage requires content; the server derives everything from ticketId,
  // so this trigger text is never read server-side — it only opens the run.
  const generate = () => void sendMessage("Generate a reply draft for this ticket.");

  return (
    <section
      data-testid="draft-panel"
      className="flex flex-col gap-3 rounded-lg border border-hairline border-l-2 border-l-primary bg-surface-2 p-4"
    >
      <div className="flex items-center gap-3">
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-semibold text-ink">Reply draft</h2>
        <Button
          type="button"
          variant="secondary"
          data-testid="generate-draft"
          onClick={generate}
          disabled={isLoading}
        >
          Generate draft
        </Button>
      </div>

      {isLoading && (
        <p data-testid="draft-streaming" className="text-xs text-ink-subtle" role="status">
          Generating draft…
        </p>
      )}

      {draft && <p className="text-sm whitespace-pre-wrap text-ink-muted">{draft}</p>}

      {error && (
        <p data-testid="draft-error" role="alert" className="text-sm text-destructive">
          Could not generate a draft. Please try again.
        </p>
      )}

      {draft && !isLoading && (
        <div className="flex justify-end">
          <Button type="button" data-testid="use-draft" onClick={() => onUseDraft(draft)}>
            Use draft
          </Button>
        </div>
      )}
    </section>
  );
}
