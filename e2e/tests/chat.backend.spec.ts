import { expect, test } from "@playwright/test";
import { snap } from "../helpers/snap";

// Full-stack tests against the real API (mock provider). Assertions are
// structural only — "a non-empty reply arrived without errors" — which is the
// exact shape a real-LLM smoke lane uses. Switching LLM_PROVIDER to a real
// provider later requires no changes here.
test.describe("chat against the real backend @backend @feature-chat", () => {
  test(
    "full-stack roundtrip renders a non-empty streamed reply",
    {
      annotation: {
        type: "description",
        description: "実APIを通した送信からストリーミング応答が空でなく表示される全経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("アプリを読み込む", async () => {
        await page.goto("/");
        await snap(page, testInfo, "初期表示");
      });

      await test.step("メッセージを送信する", async () => {
        await page.getByLabel("Message").fill("Hello backend");
        await page.getByRole("button", { name: "Send" }).click();
        await expect(page.getByTestId("typing-indicator")).toBeVisible();
        await snap(page, testInfo, "ストリーミング中");
      });

      await test.step("応答を受信する", async () => {
        await expect(page.getByTestId("typing-indicator")).toBeHidden({
          timeout: 30_000,
        });
        await expect(page.getByTestId("message-assistant")).not.toBeEmpty();
        await expect(page.getByTestId("error-banner")).toBeHidden();
        await snap(page, testInfo, "応答表示");
      });

      // Content-independent structure: exactly what a real-LLM smoke run
      // can still assert when the reply text is nondeterministic.
      await expect(page.locator("main")).toMatchAriaSnapshot(`
      - list:
        - listitem: /user/
        - listitem: /assistant/
      - textbox "Message"
    `);
    },
  );

  test(
    "surfaces a provider failure as an error banner",
    {
      annotation: {
        type: "description",
        description: "プロバイダ失敗時に実APIからのエラーがエラーバナーとして表示されることを検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("アプリを読み込む", async () => {
        await page.goto("/");
        await snap(page, testInfo, "初期表示");
      });

      await test.step("プロバイダ失敗を発生させる", async () => {
        await page.getByLabel("Message").fill("__error__");
        await page.getByRole("button", { name: "Send" }).click();
        await expect(page.getByTestId("error-banner")).toBeVisible();
        await expect(page.getByLabel("Message")).toBeEnabled();
        await snap(page, testInfo, "エラー表示");
      });
    },
  );
});
