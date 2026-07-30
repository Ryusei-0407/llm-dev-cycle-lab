import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Pool } from "../db.js";
import type { SessionStore } from "./session.js";
import { userById, type User } from "./users.js";

// WebAuthn passkey routes (spec: specs/passkey.md). The cryptographic checks
// (attestation/assertion) are delegated to a PasskeyVerifier so unit tests can
// inject a stub that observes the wiring — challenge issuance, single-use store,
// row persistence, session cookie — while E2E drives the real @simplewebauthn
// verifier through Playwright's virtual authenticator.
//
// The router never reads credential fields off the client payload itself: the
// verifier owns that (the stub reads {credentialId, publicKey, counter}; the
// real one parses the WebAuthn RegistrationResponseJSON). The router only holds
// the challenge store and DB persistence.
export interface PasskeyVerifier {
  verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
  }): Promise<{ verified: boolean; credentialId: string; publicKey: string; counter: number }>;
  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    credential: { credentialId: string; publicKey: string; counter: number };
  }): Promise<{ verified: boolean; newCounter: number }>;
}

// Short-lived, single-use challenge store (spec: in-memory, TTL 2 min, consumed
// on take). Keyed by sid for registration (tied to the caller's session) and by
// a generated challengeId for login (username-less, no session yet). take()
// deletes the entry, so a replay of the same challenge finds nothing → 400/401.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function createChallengeStore() {
  const entries = new Map<string, { challenge: string; expiresAt: number }>();
  return {
    put(key: string, challenge: string) {
      entries.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    },
    take(key: string): string | null {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt < Date.now()) return null;
      return entry.challenge;
    },
  };
}

// rpID is the Web origin hostname (dev/E2E: localhost); expectedOrigin comes
// from the request Origin header (spec). A missing Origin (non-browser callers
// such as the unit tests) falls back to the rpID-derived origin — the default
// verifier is never exercised there, so the value only needs to be well-formed.
function rpIDFromOrigin(origin: string | undefined): string {
  if (!origin) return "localhost";
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}

// Default verifier: the real @simplewebauthn/server. rpID/origin are derived
// per-request from the browser Origin so the same build serves dev, E2E, and
// any deployed host without hardcoding.
function createSimpleWebAuthnVerifier(origin: string | undefined): PasskeyVerifier {
  const rpID = rpIDFromOrigin(origin);
  const expectedOrigin = origin ?? `http://${rpID}`;
  return {
    async verifyRegistration({ response, expectedChallenge }) {
      const verification = await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
      const info = verification.registrationInfo;
      if (!verification.verified || !info) {
        return { verified: false, credentialId: "", publicKey: "", counter: 0 };
      }
      return {
        verified: true,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
      };
    },
    async verifyAuthentication({ response, expectedChallenge, credential }) {
      const verification = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, "base64url"),
          counter: credential.counter,
        },
      });
      return {
        verified: verification.verified,
        newCounter: verification.authenticationInfo?.newCounter ?? credential.counter,
      };
    },
  };
}

interface PasskeyRow {
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
}

// The passkey sub-router, mounted at /api/auth/passkey. It shares the session
// store and cookie name with the password router so a passkey login issues the
// exact same sid cookie (spec: behaviour identical to password login).
export function createPasskeyRouter(args: {
  pool: Pool;
  sessions: SessionStore;
  cookieName: string;
  resolveUser: (c: import("hono").Context) => Promise<User | null>;
  verifier?: PasskeyVerifier;
}) {
  const { pool, sessions, cookieName, resolveUser } = args;
  const registerChallenges = createChallengeStore();
  const loginChallenges = createChallengeStore();
  const router = new Hono();

  // The verifier is either injected (unit stub) or the real @simplewebauthn one,
  // built per-request so rpID/origin track the calling browser.
  const verifierFor = (origin: string | undefined): PasskeyVerifier =>
    args.verifier ?? createSimpleWebAuthnVerifier(origin);

  router.post("/register/options", async (c) => {
    const user = await resolveUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const options = await generateRegistrationOptions({
      rpName: "サポートデスク",
      rpID: rpIDFromOrigin(c.req.header("origin")),
      userName: user.email,
      userDisplayName: user.name,
    });
    // Keyed by sid, not user.id (spec: sid キーで保存): two concurrent sessions of
    // the same user (E2E runs the seed agent in parallel) each register against
    // their own challenge, so one session's options can't overwrite another's.
    registerChallenges.put(getCookie(c, cookieName) ?? user.id, options.challenge);
    return c.json(options);
  });

  router.post("/register", async (c) => {
    const user = await resolveUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const body = (await c.req.json().catch(() => null)) as {
      response?: unknown;
      challenge?: unknown;
    } | null;
    if (!body || typeof body.challenge !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }

    // Single-use: the stored challenge is consumed here. A mismatch or a replay
    // (already-consumed challenge) both resolve to no stored value → 400.
    const stored = registerChallenges.take(getCookie(c, cookieName) ?? user.id);
    if (!stored || stored !== body.challenge) {
      return c.json({ error: "challenge_mismatch" }, 400);
    }

    // @simplewebauthn throws on a malformed/forged attestation rather than
    // returning verified:false — normalize both to a 400 client error, never a
    // 500 leaking an internal stack.
    let verification: Awaited<ReturnType<PasskeyVerifier["verifyRegistration"]>>;
    try {
      verification = await verifierFor(c.req.header("origin")).verifyRegistration({
        response: body.response,
        expectedChallenge: stored,
      });
    } catch {
      return c.json({ error: "registration_failed" }, 400);
    }
    if (!verification.verified) {
      return c.json({ error: "registration_failed" }, 400);
    }

    try {
      await pool.query(
        "INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, $2, $3, $4)",
        [user.id, verification.credentialId, verification.publicKey, verification.counter],
      );
    } catch (err) {
      // credential_id UNIQUE violation (pg code 23505) = this passkey is already
      // registered; a duplicate registration is a client error, not a 500.
      if ((err as { code?: string })?.code === "23505") {
        return c.json({ error: "credential_exists" }, 409);
      }
      throw err;
    }
    return c.json({ ok: true }, 201);
  });

  router.post("/login/options", async (c) => {
    const options = await generateAuthenticationOptions({
      rpID: rpIDFromOrigin(c.req.header("origin")),
      // Empty allowCredentials = discoverable/username-less: the authenticator
      // picks the credential, so the server needs no user hint up front.
      allowCredentials: [],
    });
    const challengeId = crypto.randomUUID();
    loginChallenges.put(challengeId, options.challenge);
    return c.json({ ...options, challengeId });
  });

  router.post("/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      response?: unknown;
      challengeId?: unknown;
    } | null;
    if (!body || typeof body.challengeId !== "string") {
      return c.json({ error: "invalid_passkey" }, 401);
    }
    const stored = loginChallenges.take(body.challengeId);
    if (!stored) return c.json({ error: "invalid_passkey" }, 401);

    // The credential id the client asserts. The stub reads it off {credentialId};
    // the real WebAuthn assertion carries it as the top-level `id` (base64url).
    const asserted = body.response as { credentialId?: unknown; id?: unknown };
    const credentialId =
      typeof asserted?.credentialId === "string"
        ? asserted.credentialId
        : typeof asserted?.id === "string"
          ? asserted.id
          : null;
    if (!credentialId) return c.json({ error: "invalid_passkey" }, 401);

    const { rows } = await pool.query<PasskeyRow>(
      "SELECT user_id, credential_id, public_key, counter FROM passkeys WHERE credential_id = $1",
      [credentialId],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "invalid_passkey" }, 401);

    // A forged/tampered assertion makes @simplewebauthn throw rather than return
    // verified:false. Normalize both to the 401 the client's login-error path
    // expects — never a 500 leaking an internal stack.
    let verification: Awaited<ReturnType<PasskeyVerifier["verifyAuthentication"]>>;
    try {
      verification = await verifierFor(c.req.header("origin")).verifyAuthentication({
        response: body.response,
        expectedChallenge: stored,
        credential: {
          credentialId: row.credential_id,
          publicKey: row.public_key,
          counter: Number(row.counter),
        },
      });
    } catch {
      return c.json({ error: "invalid_passkey" }, 401);
    }
    if (!verification.verified) return c.json({ error: "invalid_passkey" }, 401);

    await pool.query("UPDATE passkeys SET counter = $1 WHERE credential_id = $2", [
      verification.newCounter,
      credentialId,
    ]);

    const user = await userById(pool, row.user_id);
    if (!user) return c.json({ error: "invalid_passkey" }, 401);

    const sid = await sessions.create(user.id);
    setCookie(c, cookieName, sid, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.json({ user });
  });

  return router;
}
