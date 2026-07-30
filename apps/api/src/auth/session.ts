import type { Pool } from "../db.js";

// pg-backed session store (spec: specs/auth-db.md). Replaces the in-memory Map
// with the sessions table so a sid survives a process restart and every app
// instance resolves the same session (storageState-reuse in E2E depends on it).
// Surface is unchanged (create/verify/destroy) but async.
export interface SessionStore {
  create(userId: string): Promise<string>;
  verify(sid: string): Promise<string | null>;
  destroy(sid: string): Promise<void>;
}

// sid stays an opaque crypto.randomUUID() (v4) — a secret token carrying no user
// data, so no chronological ordering is needed (spec). The sessions.sid column
// is uuid-typed; a client-supplied cookie may be any string, so verify/destroy
// guard the shape rather than letting a malformed value raise a pg error (a bad
// sid is an unknown session, i.e. null, not a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDbSessionStore(pool: Pool): SessionStore {
  return {
    async create(userId) {
      const sid = crypto.randomUUID();
      await pool.query("INSERT INTO sessions (sid, user_id) VALUES ($1, $2)", [sid, userId]);
      return sid;
    },
    async verify(sid) {
      if (!UUID_RE.test(sid)) return null;
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM sessions WHERE sid = $1",
        [sid],
      );
      return rows[0]?.user_id ?? null;
    },
    async destroy(sid) {
      if (!UUID_RE.test(sid)) return;
      await pool.query("DELETE FROM sessions WHERE sid = $1", [sid]);
    },
  };
}
