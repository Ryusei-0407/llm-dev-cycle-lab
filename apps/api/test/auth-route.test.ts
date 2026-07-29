import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// Auth is exercised through the public HTTP surface (specs/auth.md) rather than
// internal modules: session store, credentials check and the auth middleware
// are all observable at the /api/auth/* endpoints. Testing the contract keeps
// these tests decoupled from the (not-yet-written) internal file layout.

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass", role: "agent", name: "Aki Agent" },
  customer: {
    email: "customer@example.com",
    password: "customer-pass",
    role: "customer",
    name: "Chika Customer",
  },
} as const;

function login(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Extracts the sid cookie value from a Set-Cookie header so follow-up requests
// can present it (Hono's app.request has no cookie jar).
function sidFrom(res: Response): string | undefined {
  const setCookie = res.headers.get("set-cookie");
  return setCookie?.match(/sid=([^;]+)/)?.[1];
}

describe("credentials validation @feature-auth", () => {
  it("accepts a known agent and returns the public user shape", async () => {
    const res = await login(createApp(), {
      email: SEED.agent.email,
      password: SEED.agent.password,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({
      email: SEED.agent.email,
      role: SEED.agent.role,
      name: SEED.agent.name,
    });
    expect(body.user.id).toBeTruthy();
    // Password must never round-trip to the client.
    expect(JSON.stringify(body.user)).not.toContain(SEED.agent.password);
  });

  it("rejects a wrong password with 401 invalid_credentials", async () => {
    const res = await login(createApp(), {
      email: SEED.agent.email,
      password: "wrong-pass",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("rejects an unknown user with 401 invalid_credentials", async () => {
    const res = await login(createApp(), {
      email: "nobody@example.com",
      password: "whatever",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });
});

describe("session store @feature-auth", () => {
  it("issues an httpOnly, sameSite=lax sid cookie on login", async () => {
    const res = await login(createApp(), {
      email: SEED.agent.email,
      password: SEED.agent.password,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/sid=/);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });

  it("resolves the current user from a valid session (create → verify)", async () => {
    const app = createApp();
    const res = await login(app, { email: SEED.agent.email, password: SEED.agent.password });
    const sid = sidFrom(res);
    expect(sid).toBeTruthy();

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `sid=${sid}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; role: string } };
    expect(body.user).toMatchObject({ email: SEED.agent.email, role: SEED.agent.role });
  });

  it("destroys the session on logout: 204 then me is 401", async () => {
    const app = createApp();
    const res = await login(app, { email: SEED.agent.email, password: SEED.agent.password });
    const sid = sidFrom(res);

    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `sid=${sid}` },
    });
    expect(out.status).toBe(204);

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `sid=${sid}` },
    });
    expect(me.status).toBe(401);
  });

  it("scopes sessions per user (customer sid resolves to the customer)", async () => {
    const app = createApp();
    const res = await login(app, {
      email: SEED.customer.email,
      password: SEED.customer.password,
    });
    const sid = sidFrom(res);

    const me = await app.request("/api/auth/me", { headers: { cookie: `sid=${sid}` } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; role: string } };
    expect(body.user).toMatchObject({ email: SEED.customer.email, role: SEED.customer.role });
  });
});

describe("auth middleware @feature-auth", () => {
  it("returns 401 unauthenticated for /me without a cookie", async () => {
    const res = await createApp().request("/api/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns 401 for /me with an unknown sid", async () => {
    const res = await createApp().request("/api/auth/me", {
      headers: { cookie: "sid=not-a-real-session" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});
