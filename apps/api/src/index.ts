import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// API_PORT is the worktree-scoped override (parallel E2E); PORT stays as the
// generic fallback so existing callers keep working.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
const app = createApp();
// @hono/node-ws needs the raw node server to handle the upgrade handshake:
// serve() returns it, injectWebSocket wires /api/ws onto it.
const server = serve({ fetch: app.fetch, port });
app.injectWebSocket(server);
console.log(`api listening on http://localhost:${port}`);
