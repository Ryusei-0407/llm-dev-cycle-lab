// Builds an AG-UI Server-Sent Events body for page.route mocks of
// /api/tickets/draft. TanStack AI's useChat parses this event sequence
// (docs: RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* →
// TEXT_MESSAGE_END → RUN_FINISHED → [DONE]). Each event is a `data: <json>\n\n`
// frame; a mid-stream failure emits RUN_ERROR instead of the trailing frames.
//
// NOTE (wire-format assumption): the exact field casing/names of AG-UI frames
// are a beta detail owned by the implementation. This helper models the
// documented shape so the mock is deterministic and needs no backend; if the
// implementer lands a different frame shape (or the spec's retreat path to a
// self-rolled /api/chat-style SSE), this helper is the single seam to update —
// the specs assert UI structure, not frame internals.
const MESSAGE_ID = "draft-msg-1";
const RUN_ID = "draft-run-1";

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// A complete, well-formed draft stream that renders `deltas.join("")` into the
// assistant message (the draft-panel).
export function aguiDraftBody(deltas: string[]): string {
  let body = "";
  body += frame({ type: "RUN_STARTED", runId: RUN_ID });
  body += frame({ type: "TEXT_MESSAGE_START", messageId: MESSAGE_ID, role: "assistant" });
  let content = "";
  for (const delta of deltas) {
    content += delta;
    body += frame({ type: "TEXT_MESSAGE_CONTENT", messageId: MESSAGE_ID, delta, content });
  }
  body += frame({ type: "TEXT_MESSAGE_END", messageId: MESSAGE_ID });
  body += frame({ type: "RUN_FINISHED", runId: RUN_ID, finishReason: "stop" });
  body += "data: [DONE]\n\n";
  return body;
}

// A stream that begins normally, emits some partial text, then fails mid-way
// with RUN_ERROR (no TEXT_MESSAGE_END / RUN_FINISHED / [DONE]). The UI must
// surface draft-error while keeping whatever partial text already rendered.
export function aguiDraftErrorBody(partialDeltas: string[]): string {
  let body = "";
  body += frame({ type: "RUN_STARTED", runId: RUN_ID });
  body += frame({ type: "TEXT_MESSAGE_START", messageId: MESSAGE_ID, role: "assistant" });
  let content = "";
  for (const delta of partialDeltas) {
    content += delta;
    body += frame({ type: "TEXT_MESSAGE_CONTENT", messageId: MESSAGE_ID, delta, content });
  }
  body += frame({ type: "RUN_ERROR", runId: RUN_ID, message: "stream_failed" });
  return body;
}
