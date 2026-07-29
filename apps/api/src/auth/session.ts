// In-memory session store (sid → userId) per specs/auth.md. A real deployment
// swaps this for a shared store behind the same create/verify/destroy surface;
// the sid is an opaque crypto.randomUUID() so it carries no user data.
export interface SessionStore {
  create(userId: string): string;
  verify(sid: string): string | null;
  destroy(sid: string): void;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, string>();
  return {
    create(userId) {
      const sid = crypto.randomUUID();
      sessions.set(sid, userId);
      return sid;
    },
    verify(sid) {
      return sessions.get(sid) ?? null;
    },
    destroy(sid) {
      sessions.delete(sid);
    },
  };
}
