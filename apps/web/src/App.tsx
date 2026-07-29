import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "./chat/useChat";

export function App() {
  const { state, slowHint, send, stop } = useChat();
  const [draft, setDraft] = useState("");
  const streaming = state.status === "streaming";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || streaming) return;
    setDraft("");
    void send(content);
  };

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold tracking-tight">LLM Dev-Cycle Lab Chat</h1>
      {state.error && (
        <div
          role="alert"
          data-testid="error-banner"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.error}
        </div>
      )}
      <ul data-testid="message-list" className="flex flex-1 flex-col gap-2">
        {state.messages
          .filter((m) => m.content !== "")
          .map((m, i) => (
            <li
              key={i}
              data-testid={`message-${m.role}`}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground"
            >
              <span className="mb-0.5 block text-xs font-medium text-muted-foreground">
                {m.role}
              </span>
              {m.content}
            </li>
          ))}
      </ul>
      {streaming && (
        <div data-testid="typing-indicator" className="text-sm text-muted-foreground italic">
          Assistant is typing…
        </div>
      )}
      {streaming && slowHint && (
        <div data-testid="slow-hint" className="text-sm text-muted-foreground">
          応答に時間がかかっています…
        </div>
      )}
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={streaming}
          placeholder="Type a message"
        />
        <Button type="submit" disabled={streaming || !draft.trim()}>
          Send
        </Button>
        {streaming && (
          <Button type="button" variant="secondary" onClick={stop}>
            Stop
          </Button>
        )}
      </form>
    </main>
  );
}
