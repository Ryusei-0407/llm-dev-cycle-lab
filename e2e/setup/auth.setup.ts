import { test as setup } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiLogin, type Role } from "../helpers/auth";

// Setup project: log each seed role in once and persist its storageState under
// e2e/.auth/<role>.json, so feature tests start already authenticated instead
// of driving /login every time. Wired as a `dependencies` of the feature
// projects that need auth (kept off the existing chromium project for now — the
// @feature-chat integration is handled in a later phase per specs/auth.md).
const authDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".auth");

for (const role of ["agent", "customer"] as Role[]) {
  setup(`authenticate as ${role}`, async ({ request }) => {
    const state = await apiLogin(request, role);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, `${role}.json`), JSON.stringify(state, null, 2));
  });
}
