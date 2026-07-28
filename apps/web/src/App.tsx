import { FormEvent, useState } from "react";
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
    <main>
      <h1>LLM Dev-Cycle Lab Chat</h1>
      {state.error && (
        <div role="alert" data-testid="error-banner">
          {state.error}
        </div>
      )}
      <ul data-testid="message-list">
        {state.messages
          .filter((m) => m.content !== "")
          .map((m, i) => (
            <li key={i} data-testid={`message-${m.role}`} className={m.role}>
              <span className="role">{m.role}</span>
              {m.content}
            </li>
          ))}
      </ul>
      {streaming && <div data-testid="typing-indicator">Assistant is typing…</div>}
      {streaming && slowHint && <div data-testid="slow-hint">応答に時間がかかっています…</div>}
      <form onSubmit={onSubmit}>
        <input
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={streaming}
          placeholder="Type a message"
        />
        <button type="submit" disabled={streaming || !draft.trim()}>
          Send
        </button>
        {streaming && (
          <button type="button" onClick={stop}>
            Stop
          </button>
        )}
      </form>
    </main>
  );
}
