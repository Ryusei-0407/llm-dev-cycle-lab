import { useState } from "react";
import { App } from "./App";

declare global {
  interface Window {
    __stream: { push(delta: string): void; done(): void };
  }
}

// Story for Playwright component tests: App wired to a stalled SSE stream the
// test drives from outside via window.__stream (stories own their
// environment; tests only observe through the page).
export const StalledStream = () => {
  useState(() => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    window.__stream = {
      push: (delta: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)),
      done: () => {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    };
    window.fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    return true;
  });
  return <App />;
};
