import type { Context } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Pool } from "../db.js";
import { createDbSessionStore } from "./session.js";
import { createPasskeyRouter, type PasskeyVerifier } from "./passkey.js";
import { userById, verifyCredentials, type User } from "./users.js";

const SID = "sid";

// Variables injected by requireAuth so protected handlers read a typed user.
type AuthEnv = { Variables: { user: User } };

// Resolves the session cookie to a user and short-circuits with 401
// unauthenticated when absent or unknown (distinct from login's
// invalid_credentials — the client tells the two apart, per specs/auth.md).
// pool-backed now (spec: specs/auth-db.md): sessions + users live in postgres,
// so credential/session lookups are async.
export function createAuthRouter(pool: Pool, passkeyVerifier?: PasskeyVerifier) {
  const sessions = createDbSessionStore(pool);

  // sid cookie → session → User, or null when absent/invalid. Shared by
  // requireAuth (Hono middleware) and the oRPC context injection in app.ts so
  // both derive the current user through one path. Here it does not
  // short-circuit: an absent session is a valid state for the oRPC context
  // (read procedures allow null; create/reply turn it into UNAUTHORIZED
  // themselves). requireAuth below is the enforcing variant.
  const resolveUser = async (c: Context): Promise<User | null> => {
    const sid = getCookie(c, SID);
    const userId = sid ? await sessions.verify(sid) : null;
    return userId ? await userById(pool, userId) : null;
  };

  const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
    const user = await resolveUser(c);
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
    const user = await verifyCredentials(pool, email, password);
    if (!user) return c.json({ error: "invalid_credentials" }, 401);

    const sid = await sessions.create(user.id);
    // Secure/Max-Age are out of scope for the tests; httpOnly + sameSite=lax are
    // the guarantees specs/auth.md pins down.
    setCookie(c, SID, sid, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.json({ user });
  });

  router.post("/logout", async (c) => {
    const sid = getCookie(c, SID);
    if (sid) await sessions.destroy(sid);
    deleteCookie(c, SID, { path: "/" });
    return c.body(null, 204);
  });

  router.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

  // Passkey sub-router (spec: specs/passkey.md). Shares the same session store
  // and sid cookie so a passkey login is indistinguishable from a password one
  // downstream. The verifier is injected in unit tests (stub) and defaults to
  // the real @simplewebauthn one otherwise.
  router.route(
    "/passkey",
    createPasskeyRouter({
      pool,
      sessions,
      cookieName: SID,
      resolveUser,
      verifier: passkeyVerifier,
    }),
  );

  return { router, requireAuth, resolveUser };
}
