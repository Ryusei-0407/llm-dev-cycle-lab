import { expect, test } from "@playwright/test";
import { snap } from "../helpers/snap";
import { SEED_USERS } from "../helpers/auth";

// Auth E2E against the real API — the store is self-implemented and
// deterministic (specs/auth.md), so no mocking is needed. These tests verify
// the login/guard plumbing (form → session → redirect), not content. The
// chromium project defaults to the seeded agent session, so this describe opts
// back out to an empty state — the login/guard flow must start unauthenticated.
test.describe("auth @feature-auth", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    "agent signs in and lands on the desk @smoke",
    {
      annotation: {
        type: "description",
        description:
          "正しい資格情報でのログインから保護ルートへの遷移とユーザー表示までの主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("visit the login page", async () => {
        await page.goto("/login");
        await snap(page, testInfo, "ログイン画面");
      });

      await test.step("submit valid agent credentials", async () => {
        await page.getByLabel("Email").fill(SEED_USERS.agent.email);
        await page.getByLabel("Password").fill(SEED_USERS.agent.password);
        await page.getByRole("button", { name: "Sign in" }).click();
      });

      await test.step("land on the protected home with the user shown", async () => {
        await expect(page).toHaveURL("/");
        await expect(page.getByTestId("current-user")).toHaveText(SEED_USERS.agent.name);
        await expect(page.getByTestId("login-error")).toBeHidden();
        await snap(page, testInfo, "ログイン後");
      });

      // Structural assertion: the signed-in shell (user identity + sign-out),
      // roles and order only — survives copy and layout changes.
      await expect(page.getByTestId("top-nav")).toMatchAriaSnapshot(`
      - button "Sign out"
    `);
    },
  );

  test(
    "wrong password shows an inline error and stays on /login",
    {
      annotation: {
        type: "description",
        description:
          "誤ったパスワードでのログイン試行時にインラインエラーが出て /login に留まることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("visit the login page", async () => {
        await page.goto("/login");
        await snap(page, testInfo, "ログイン画面");
      });

      await test.step("submit a wrong password", async () => {
        await page.getByLabel("Email").fill(SEED_USERS.agent.email);
        await page.getByLabel("Password").fill("wrong-pass");
        await page.getByRole("button", { name: "Sign in" }).click();
      });

      await test.step("see the error and remain unauthenticated", async () => {
        await expect(page.getByTestId("login-error")).toBeVisible();
        await expect(page).toHaveURL("/login");
        await snap(page, testInfo, "認証失敗");
      });
    },
  );

  test(
    "unauthenticated access to a protected route redirects to /login",
    {
      annotation: {
        type: "description",
        description:
          "未認証で保護ルートへ直接アクセスした際に /login へリダイレクトされることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("hit the protected home directly", async () => {
        await page.goto("/");
      });

      await test.step("get redirected to the login page", async () => {
        await expect(page).toHaveURL("/login");
        await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
        await snap(page, testInfo, "ガードでリダイレクト");
      });
    },
  );
});
