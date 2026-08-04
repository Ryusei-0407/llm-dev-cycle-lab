import { test as setup } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_SIDS } from "../worker-stack";

// Setup project: write the two storageState files feature tests start from.
// No login happens here — the login/passkey flows are covered by their own
// specs (auth.spec / passkey.spec), and re-driving auth in front of every
// other test would only re-test what those already pin. Instead each worker's
// per-test DB reset (worker-stack.ts) plants fixed-sid session rows, and
// these files carry the matching sid cookie. Cookies are port-agnostic
// (domain only), so one file works for every worker's web port.
const authDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".auth");

// Mirrors the wire cookie exactly (auth routes: sid, httpOnly, Lax, path=/,
// session-scoped) — the only difference from a logged-in state is the value.
const storageState = (sid: string) => ({
  cookies: [
    {
      name: "sid",
      value: sid,
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
});

setup("write fixed-session storage states", async () => {
  await mkdir(authDir, { recursive: true });
  for (const role of ["agent", "customer"] as const) {
    await writeFile(
      path.join(authDir, `${role}.json`),
      JSON.stringify(storageState(FIXED_SIDS[role]), null, 2),
    );
  }
});
