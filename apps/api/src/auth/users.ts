export type Role = "agent" | "customer";

export interface User {
  id: string;
  email: string;
  role: Role;
  name: string;
}

// The stored record carries the password; only the public User shape (without
// it) ever leaves the API. Deterministic seed data per specs/auth.md — no
// hashing here, the store is in-memory and the credentials are fixtures.
interface SeedUser extends User {
  password: string;
}

const SEED_USERS: readonly SeedUser[] = [
  {
    id: "u_agent",
    email: "agent@example.com",
    password: "agent-pass",
    role: "agent",
    name: "Aki Agent",
  },
  {
    id: "u_customer",
    email: "customer@example.com",
    password: "customer-pass",
    role: "customer",
    name: "Chika Customer",
  },
];

function toPublic(user: SeedUser): User {
  const { password: _password, ...pub } = user;
  return pub;
}

// Returns the public user for matching credentials, or null. Unknown email and
// wrong password are indistinguishable to the caller (both null) so the route
// can answer a single invalid_credentials.
export function verifyCredentials(email: string, password: string): User | null {
  const match = SEED_USERS.find((u) => u.email === email && u.password === password);
  return match ? toPublic(match) : null;
}

export function userById(id: string): User | null {
  const match = SEED_USERS.find((u) => u.id === id);
  return match ? toPublic(match) : null;
}
