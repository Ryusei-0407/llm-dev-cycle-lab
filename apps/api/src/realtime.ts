// In-memory WebSocket fan-out for ticket changes (spec: specs/ws-realtime.md).
// The hub holds the live connection set; the tickets router broadcasts a
// {type, ticketId} event after a successful mutation and every open client
// re-fetches through its own authorised list/get. No payload beyond the id, so
// authz stays with the existing read procedures.

import { currentSchema } from "./e2e-schema.js";

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
  // scope: E2E worker isolation (e2e-schema.ts). Sockets register under the
  // schema scope their upgrade request carried, and a broadcast only reaches
  // sockets in the broadcaster's scope — a worker's mutations must not ripple
  // refetches into other workers' pages. Default scope "" (production: every
  // socket and every broadcast).
  register(ws: RealtimeSocket, scope?: string): void;
  broadcast(event: RealtimeEvent): void;
  size(): number;
};

export function createRealtimeHub(): RealtimeHub {
  const buckets = new Map<string, Set<RealtimeSocket>>();

  const bucket = (scope: string): Set<RealtimeSocket> => {
    let set = buckets.get(scope);
    if (!set) {
      set = new Set();
      buckets.set(scope, set);
    }
    return set;
  };

  return {
    register(ws, scope = "") {
      bucket(scope).add(ws);
    },
    broadcast(event) {
      const data = JSON.stringify(event);
      // The broadcast scope is the caller's request scope: router handlers run
      // inside the isolation middleware's AsyncLocalStorage context.
      const sockets = bucket(currentSchema());
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
      let total = 0;
      for (const set of buckets.values()) total += set.size;
      return total;
    },
  };
}
