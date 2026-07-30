import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { orpc } from "./orpc";

// Realtime invalidation (spec: specs/ws-realtime.md). Connects to /api/ws and,
// on each {type, ticketId} event, invalidates the matching TanStack Query keys
// so open views re-fetch through their own authorised list/get. The socket is a
// progressive enhancement: if it never opens (blocked) or drops, the app keeps
// working — manual actions already invalidate on their own success.

type RealtimeEvent = {
  type: "ticket.created" | "ticket.updated" | "message.created";
  ticketId: string;
};

// Exponential backoff bounds for reconnection (spec: 初回1s、最大30s). Kept as
// module constants so the shape of the backoff is visible in one place.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!value || typeof value !== "object") return false;
  const { type, ticketId } = value as Record<string, unknown>;
  return (
    (type === "ticket.created" || type === "ticket.updated" || type === "message.created") &&
    typeof ticketId === "string"
  );
}

export function useRealtimeInvalidation(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Same-origin ws:// (or wss:// under https): the Vite proxy (ws: true)
    // forwards /api/ws to the API, so the client never encodes the API port —
    // it mirrors how orpc derives its URL from window.location.origin.
    const wsUrl = `${window.location.origin.replace(/^http/, "ws")}/api/ws`;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = RECONNECT_MIN_MS;
    let disposed = false;

    const invalidate = (event: RealtimeEvent) => {
      // ticket.created/updated change the list; created/updated also change that
      // ticket's detail. message.created only changes the detail thread. `.key`
      // is a partial match, so the detail key matches regardless of query input
      // options.
      if (event.type === "ticket.created" || event.type === "ticket.updated") {
        void queryClient.invalidateQueries({ queryKey: orpc.tickets.list.key() });
      }
      void queryClient.invalidateQueries({
        queryKey: orpc.tickets.get.key({ input: { id: event.ticketId } }),
      });
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        backoff = RECONNECT_MIN_MS; // healthy connection resets the backoff.
      };
      socket.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(event.data as string);
          if (isRealtimeEvent(parsed)) invalidate(parsed);
        } catch {
          // A malformed frame is ignored, not fatal: realtime is best-effort.
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        // Reconnect with exponential backoff so a downed API (or a dropped
        // socket) is retried without hammering it.
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      };
      // onerror precedes onclose; swallow it so no unhandled error surfaces.
      // The reconnect is driven by onclose.
      socket.onerror = () => {};
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Drop the close handler before closing so teardown doesn't schedule a
      // reconnect against an unmounted component.
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [queryClient]);
}
