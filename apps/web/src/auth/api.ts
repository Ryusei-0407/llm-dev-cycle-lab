export type Role = "agent" | "customer";

export interface User {
  id: string;
  email: string;
  role: Role;
  name: string;
}

// Fetches the current session user, or null when unauthenticated (401). The
// cookie rides along automatically (same-origin); callers never touch the sid.
export async function fetchMe(): Promise<User | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me failed (${res.status})`);
  const body = (await res.json()) as { user: User };
  return body.user;
}

export type LoginResult = { ok: true; user: User } | { ok: false; error: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) {
    const body = (await res.json()) as { user: User };
    return { ok: true, user: body.user };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? "login_failed" };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
