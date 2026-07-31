import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";
import { SEED_USERS } from "../helpers/auth";
import { clearCredentials, installAuthenticator } from "../helpers/webauthn";

// passkey E2E(spec: specs/passkey.md E2E観点)— 実 @simplewebauthn + Playwright
// 1.62 の仮想オーセンティケータで全周を配線検証する。password ログインでの初回認証、
// パスキー登録、ユーザー名レス・パスキーログインの「配管」(フォーム → 資格情報 →
// セッション → 遷移)を見る。内容ではなく構造(aria snapshot)をアサートする。
//
// chromium プロジェクトは既定でシード agent セッションを張るが、この機能は
// 「未認証 → password ログイン → 登録 → sign out → パスキーでログイン」の全周なので、
// auth.spec.ts と同様に空の storageState に opt-out して未認証から始める。
// 仮想オーセンティケータは各テストの前処理で install する(実オーセンティケータを
// 無効化し、navigator.credentials.create/get に自動応答させる)。
test.describe("passkey @feature-passkey", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ context }) => {
    await installAuthenticator(context);
    // 前テストの登録鍵が context に残らないよう、各テスト開始時に鍵集合を空にする。
    await clearCredentials(context);
  });

  test(
    "パスキーを登録して次回ユーザー名レスでログインできる @smoke",
    {
      annotation: {
        type: "description",
        description:
          "password でログイン → パスキーを登録 → サインアウト → /login からユーザー名レスのパスキーでログインが成立し、ユーザー表示のあるホームに到達する全周を検証",
      },
    },
    async ({ page, context }, testInfo) => {
      await test.step("password でログインする", async () => {
        await page.goto("/login");
        await snap(page, testInfo, "ログイン画面");
        await page.getByLabel("Email").fill(SEED_USERS.agent.email);
        await page.getByLabel("Password").fill(SEED_USERS.agent.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL("/");
        await expect(page.getByTestId("current-user")).toHaveText(SEED_USERS.agent.name);
      });

      await test.step("パスキーを登録する(仮想オーセンティケータが応答)", async () => {
        await page.getByTestId("passkey-register").click();
        await expect(page.getByTestId("passkey-registered")).toBeVisible();
        // オーセンティケータ側に鍵が1件生成されたことを確認(navigator.credentials.create)。
        expect(await context.credentials.get()).toHaveLength(1);
        await snap(page, testInfo, "パスキー登録済み");
      });

      await test.step("サインアウトする", async () => {
        await page.getByRole("button", { name: "Sign out" }).click();
        await expect(page).toHaveURL("/login");
        await snap(page, testInfo, "サインアウト後");
      });

      await test.step("ユーザー名レスのパスキーでログインする", async () => {
        await page.getByTestId("passkey-login").click();
        await expect(page).toHaveURL("/");
        await expect(page.getByTestId("current-user")).toHaveText(SEED_USERS.agent.name);
        await snap(page, testInfo, "パスキーログイン後");
      });

      // 構造アサーション: サインイン後シェル(ユーザー表示 + Sign out)。role と順序
      // のみ — コピーやレイアウト変更に耐える。サインイン後の chrome は TopNav から
      // App shell のサイドバーへ移った(specs/app-shell.md)。
      // コンテナの存在確認を先に置く: toMatchAriaSnapshot は locator が不在でも
      // パターンを広いツリーに対して照合してしまう(別所の "Sign out" ボタンで
      // 成立する)ため、この可視チェックが testid 改名を固定する。無いと旧 top-nav
      // のままでもアサーションが通ってしまう。
      await expect(page.getByTestId("app-sidebar")).toBeVisible();
      await expect(page.getByTestId("app-sidebar")).toMatchAriaSnapshot(`
      - button "Sign out"
    `);
    },
  );

  test(
    "未登録状態のパスキーログインは失敗し /login に留まる",
    {
      annotation: {
        type: "description",
        description:
          "パスキーを一度も登録していない状態で /login のパスキーログインを押すと、資格情報が無く login-error が表示され /login に留まることを検証(登録フローを踏まない失敗経路)",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("未登録のまま /login を開く", async () => {
        await page.goto("/login");
        await snap(page, testInfo, "ログイン画面(未登録)");
      });

      await test.step("パスキーでログインを試みる", async () => {
        await page.getByTestId("passkey-login").click();
      });

      await test.step("エラー表示と未ログインのままであることを確認する", async () => {
        await expect(page.getByTestId("login-error")).toBeVisible();
        await expect(page).toHaveURL("/login");
        await snap(page, testInfo, "パスキーログイン失敗(未登録)");
      });
    },
  );

  test(
    "登録後にオーセンティケータから鍵を消すとパスキーログインは失敗する",
    {
      annotation: {
        type: "description",
        description:
          "パスキー登録後にオーセンティケータ側の鍵を削除してからパスキーログインすると、サーバーが解決できる鍵をアサーションできず login-error が表示され /login に留まることを検証(登録済みとは別の失敗面)",
      },
    },
    async ({ page, context }, testInfo) => {
      await test.step("password でログインしてパスキーを登録する", async () => {
        await page.goto("/login");
        await page.getByLabel("Email").fill(SEED_USERS.agent.email);
        await page.getByLabel("Password").fill(SEED_USERS.agent.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL("/");
        await page.getByTestId("passkey-register").click();
        await expect(page.getByTestId("passkey-registered")).toBeVisible();
        await snap(page, testInfo, "パスキー登録済み");
      });

      await test.step("サインアウトしてオーセンティケータから鍵を消す", async () => {
        await page.getByRole("button", { name: "Sign out" }).click();
        await expect(page).toHaveURL("/login");
        await clearCredentials(context);
        expect(await context.credentials.get()).toHaveLength(0);
        await snap(page, testInfo, "鍵削除後");
      });

      await test.step("パスキーでログインを試みて失敗する", async () => {
        await page.getByTestId("passkey-login").click();
        await expect(page.getByTestId("login-error")).toBeVisible();
        await expect(page).toHaveURL("/login");
        await snap(page, testInfo, "パスキーログイン失敗(鍵削除)");
      });
    },
  );
});
