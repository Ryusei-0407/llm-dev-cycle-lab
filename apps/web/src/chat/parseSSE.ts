export type SSEPayload = { delta: string } | { error: string } | "DONE";

// Incremental SSE parser. feed() accepts arbitrary chunk boundaries (a network
// chunk may split an event in half) and returns only fully-received events.
export function createSSEParser() {
  let buffer = "";
  return {
    feed(chunk: string): SSEPayload[] {
      buffer += chunk;
      const events: SSEPayload[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice("data: ".length);
          if (data === "[DONE]") {
            events.push("DONE");
            continue;
          }
          try {
            const parsed: unknown = JSON.parse(data);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "delta" in parsed &&
              typeof (parsed as { delta: unknown }).delta === "string"
            ) {
              events.push({ delta: (parsed as { delta: string }).delta });
            } else if (
              typeof parsed === "object" &&
              parsed !== null &&
              "error" in parsed &&
              typeof (parsed as { error: unknown }).error === "string"
            ) {
              events.push({ error: (parsed as { error: string }).error });
            }
          } catch {
            // Malformed events are dropped; the stream-level error path
            // (missing [DONE]) is handled by the caller.
          }
        }
      }
      return events;
    },
  };
}
