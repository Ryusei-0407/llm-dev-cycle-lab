import { scryptSync, timingSafeEqual } from "node:crypto";
import type { Pool } from "../db.js";

export type Role = "agent" | "customer";

export interface User {
  id: string;
  email: string;
  role: Role;
  name: string;
}

// The public columns only: password_hash stays in the DB and never leaves the
// API (spec: specs/auth-db.md). Column order matches the SELECT lists below.
type Row = {
  id: string;
  email: string;
  role: Role;
  name: string;
};

const PUBLIC_COLUMNS = "id, email, role, name";

// Constant-time compare of a plaintext against a stored "salt:hexhash" (scrypt,
// 64-byte key — same parameters seed.sql was computed with). timingSafeEqual
// avoids leaking the match position; a malformed hash or a length mismatch is a
// non-match, not an error, so the caller still answers a single null.
function passwordMatches(plaintext: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = stored.slice(0, sep);
  const expectedHex = stored.slice(sep + 1);
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(plaintext, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Returns the public user for matching credentials, or null. Unknown email and
// wrong password are indistinguishable to the caller (both null) so the route
// can answer a single invalid_credentials.
export async function verifyCredentials(
  pool: Pool,
  email: string,
  password: string,
): Promise<User | null> {
  const { rows } = await pool.query<Row & { password_hash: string }>(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row || !passwordMatches(password, row.password_hash)) return null;
  const { password_hash: _hash, ...pub } = row;
  return pub;
}

export async function userById(pool: Pool, id: string): Promise<User | null> {
  const { rows } = await pool.query<Row>(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
