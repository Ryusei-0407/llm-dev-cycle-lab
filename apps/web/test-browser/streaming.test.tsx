import { page } from "@vitest/browser/context";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { App } from "../src/App";

// Component-layer test (Vitest Browser Mode): verifies *incremental*
// streaming render in a real browser — each SSE chunk must appear as it
// arrives, not only after the stream closes. E2E route.fulfill() cannot
// test this (it delivers the whole body at once) and JSDOM cannot be
// trusted for it.

const encoder = new TextEncoder();

function stubStreamingFetch() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  return {
    push: (delta: string) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)),
    done: () => {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  };
}

test("renders each streamed chunk as it arrives", async () => {
  const upstream = stubStreamingFetch();
  render(<App />);

  await page.getByLabelText("Message").fill("Hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.element(page.getByTestId("typing-indicator")).toBeVisible();

  // First chunk shows up while the stream is still open.
  upstream.push("Incre");
  await expect.element(page.getByTestId("message-assistant")).toHaveTextContent(/Incre$/);

  // Next chunk appends without losing the previous one.
  upstream.push("mental");
  await expect.element(page.getByTestId("message-assistant")).toHaveTextContent(/Incremental$/);

  upstream.done();
  await expect.element(page.getByTestId("typing-indicator")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("error-banner")).not.toBeInTheDocument();

  vi.unstubAllGlobals();
});
