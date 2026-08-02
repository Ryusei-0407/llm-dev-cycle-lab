import { useChat } from "@tanstack/ai-react";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "@/lib/orpc";

// copilot (spec: specs/copilot.md). A docked chat that answers status questions
// over Server-Sent Events using @tanstack/ai-react's useChat (draft-panel の
// 流儀). Lives under AppShell so it stays open across route changes; the open
// state and the Ctrl/⌘+/ shortcut are owned by AppShell.

// A single assistant/user message rendered from its AG-UI text parts (useChat
// appends deltas into these parts as the stream arrives).
type ChatMessage = ReturnType<typeof useChat>["messages"][number];

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; content: string } => p.type === "text")
    .map((p) => p.content)
    .join("");
}

// SUP-\d+ in assistant text becomes a clickable ref (spec): clicking resolves
// the number through tickets.search and navigates to the first hit's detail. A
// bare number match keeps its SUP- prefix in the label.
const SUP_REF = /SUP-\d+/g;

export function CopilotPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The server derives everything from the SQL snapshot + the wire messages, so
  // no request body data is needed beyond the conversation useChat sends.
  // credentials "include" carries the session cookie (the route is auth-gated).
  const connection = useMemo(
    () => fetchServerSentEvents("/api/copilot/chat", { credentials: "include" }),
    [],
  );
  const { messages, sendMessage, error } = useChat({ connection });

  const [draft, setDraft] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void sendMessage(content);
  };

  // Resolve a SUP-{number} reference to a ticket id via tickets.search and go to
  // its detail. No hit is a no-op (spec). fetchQuery reuses the query cache the
  // command palette already warms.
  const goToRef = async (ref: string) => {
    const result = await queryClient.fetchQuery(
      orpc.tickets.search.queryOptions({ input: { q: ref } }),
    );
    const first = result[0];
    if (first) void navigate({ to: "/tickets/$id", params: { id: first.id } });
  };

  return (
    <section
      data-testid="copilot-panel"
      className="fixed right-4 bottom-4 z-40 flex max-h-[70dvh] w-96 flex-col overflow-hidden rounded-lg border border-hairline bg-surface-3 shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold text-ink">Copilot</h2>
        <button
          type="button"
          data-testid="copilot-close"
          onClick={onClose}
          className="text-sm text-ink-subtle transition-colors hover:text-ink"
        >
          閉じる
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages.map((message) =>
          message.role === "user" ? (
            <p
              key={message.id}
              data-testid="copilot-user"
              className="self-end rounded-lg bg-surface-1 px-3 py-2 text-sm text-ink"
            >
              {messageText(message)}
            </p>
          ) : (
            <p
              key={message.id}
              data-testid="copilot-assistant"
              className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-ink"
            >
              <AssistantText text={messageText(message)} onRefClick={goToRef} />
            </p>
          ),
        )}
        {error && (
          <p data-testid="copilot-error" role="alert" className="text-sm text-destructive">
            回答の取得に失敗しました。
          </p>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-hairline px-4 py-3"
      >
        <Input
          data-testid="copilot-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="チケットについて質問…"
        />
        <Button type="submit" data-testid="copilot-send" disabled={!draft.trim()}>
          送信
        </Button>
      </form>
    </section>
  );
}

// Render assistant text with SUP-{number} spans turned into ref links. The plain
// segments between matches are preserved verbatim so the streamed line reads
// normally; each ref carries copilot-ref for the E2E click.
function AssistantText({ text, onRefClick }: { text: string; onRefClick: (ref: string) => void }) {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(SUP_REF)) {
    const start = match.index;
    if (start > lastIndex)
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, start)}</Fragment>);
    const ref = match[0];
    nodes.push(
      <button
        key={key++}
        type="button"
        data-testid="copilot-ref"
        onClick={() => onRefClick(ref)}
        className="text-accent underline underline-offset-2"
      >
        {ref}
      </button>,
    );
    lastIndex = start + ref.length;
  }
  if (lastIndex < text.length) nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  return <>{nodes}</>;
}
