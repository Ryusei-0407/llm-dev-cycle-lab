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

// Passkey ceremonies (spec: specs/passkey.md). Both fetch options from the
// server, run the browser WebAuthn call, and POST the result back. Register
// requires the caller's session (cookie rides along); login is username-less.
// Errors (cancelled ceremony, server 4xx) surface as a rejected boolean so the
// UI shows its feedback without leaking the reason.
import { createPasskeyCredential, getPasskeyAssertion } from "@/lib/webauthn";

export async function registerPasskey(): Promise<boolean> {
  try {
    const optRes = await fetch("/api/auth/passkey/register/options", { method: "POST" });
    if (!optRes.ok) return false;
    const options = (await optRes.json()) as Record<string, unknown>;
    const body = await createPasskeyCredential(options);
    const res = await fetch("/api/auth/passkey/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function passkeyLogin(): Promise<LoginResult> {
  try {
    const optRes = await fetch("/api/auth/passkey/login/options", { method: "POST" });
    if (!optRes.ok) return { ok: false, error: "passkey_failed" };
    const options = (await optRes.json()) as Record<string, unknown> & { challengeId: string };
    const response = await getPasskeyAssertion(options);
    const res = await fetch("/api/auth/passkey/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response, challengeId: options.challengeId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { user: User };
      return { ok: true, user: data.user };
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "passkey_failed" };
  } catch {
    return { ok: false, error: "passkey_failed" };
  }
}
