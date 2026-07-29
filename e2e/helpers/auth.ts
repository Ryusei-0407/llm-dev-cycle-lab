import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

// Deterministic seed users from specs/auth.md. Kept here (not in specs) so the
// E2E lane has one source for role → credentials; the API owns the real store.
export const SEED_USERS = {
  agent: { email: "agent@example.com", password: "agent-pass", name: "Aki Agent" },
  customer: { email: "customer@example.com", password: "customer-pass", name: "Chika Customer" },
} as const;

export type Role = keyof typeof SEED_USERS;

// Logs in over the API and returns the resulting storageState (cookies), so a
// test or the setup project can seed an authenticated context without driving
// the /login UI. request.baseURL comes from the Playwright config, so no
// connection info is hardcoded here.
export async function apiLogin(request: APIRequestContext, role: Role) {
  const { email, password } = SEED_USERS[role];
  const res = await request.post("/api/auth/login", { data: { email, password } });
  expect(res.ok(), `apiLogin(${role}) expected 2xx, got ${res.status()}`).toBeTruthy();
  return request.storageState();
}
