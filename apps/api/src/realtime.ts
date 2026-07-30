// In-memory WebSocket fan-out for ticket changes (spec: specs/ws-realtime.md).
// The hub holds the live connection set; the tickets router broadcasts a
// {type, ticketId} event after a successful mutation and every open client
// re-fetches through its own authorised list/get. No payload beyond the id, so
// authz stays with the existing read procedures.

// ws readyState OPEN. Kept as a local constant so the hub never imports the ws
// runtime (it only needs the numeric contract shared by browser + node ws).
const WS_OPEN = 1;

export type RealtimeEvent = {
  type: "ticket.created" | "ticket.updated" | "message.created";
  ticketId: string;
};

// Minimal socket the hub drives: a JSON string sink plus the OPEN/closed
// readyState. Both @hono/node-ws sockets and the unit mocks satisfy it.
export type RealtimeSocket = {
  readyState: number;
  send(data: string): void;
};

export type RealtimeHub = {
  register(ws: RealtimeSocket): void;
  broadcast(event: RealtimeEvent): void;
  size(): number;
};

export function createRealtimeHub(): RealtimeHub {
  const sockets = new Set<RealtimeSocket>();

  return {
    register(ws) {
      sockets.add(ws);
    },
    broadcast(event) {
      const data = JSON.stringify(event);
      // A socket that is no longer OPEN, or whose send throws (closed mid-flight),
      // is evicted here rather than waiting for a close event — broadcast is the
      // only place liveness is observed, so it doubles as the reaper.
      for (const ws of sockets) {
        if (ws.readyState !== WS_OPEN) {
          sockets.delete(ws);
          continue;
        }
        try {
          ws.send(data);
        } catch {
          sockets.delete(ws);
        }
      }
    },
    size() {
      return sockets.size;
    },
  };
}
