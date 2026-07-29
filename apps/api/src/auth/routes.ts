import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSessionStore } from "./session.js";
import { userById, verifyCredentials, type User } from "./users.js";

const SID = "sid";

// Variables injected by requireAuth so protected handlers read a typed user.
type AuthEnv = { Variables: { user: User } };

// Resolves the session cookie to a user and short-circuits with 401
// unauthenticated when absent or unknown (distinct from login's
// invalid_credentials — the client tells the two apart, per specs/auth.md).
export function createAuthRouter() {
  const sessions = createSessionStore();

  const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
    const sid = getCookie(c, SID);
    const userId = sid ? sessions.verify(sid) : null;
    const user = userId ? userById(userId) : null;
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    await next();
  });

  const router = new Hono();

  router.post("/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== "string" || typeof password !== "string") {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const user = verifyCredentials(email, password);
    if (!user) return c.json({ error: "invalid_credentials" }, 401);

    const sid = sessions.create(user.id);
    // Secure/Max-Age are out of scope for the tests and the store is in-memory;
    // httpOnly + sameSite=lax are the guarantees specs/auth.md pins down.
    setCookie(c, SID, sid, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.json({ user });
  });

  router.post("/logout", (c) => {
    const sid = getCookie(c, SID);
    if (sid) sessions.destroy(sid);
    deleteCookie(c, SID, { path: "/" });
    return c.body(null, 204);
  });

  router.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

  return { router, requireAuth };
}
