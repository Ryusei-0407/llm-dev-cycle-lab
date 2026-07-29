import { expect, test } from "@playwright/test";

// The story (apps/web/src/App.story.tsx) exposes this hook; the e2e TS
// program cannot see the story's declaration, so it is re-declared here.
declare global {
  interface Window {
    __stream: { push(delta: string): void; done(): void };
  }
}

// Component test (Playwright stories & galleries). This lives here, not in
// Vitest Browser Mode, because it needs page.clock — the 10s slow-hint timer
// must be driven deterministically, and Playwright's clock replaces timers at
// the context level before any page code runs.
test.describe("slow-hint @component @feature-slow-hint", () => {
  test(
    "appears after 10s of stalled streaming and clears on completion",
    {
      annotation: {
        type: "description",
        description: "ストリーミングが10秒停滞するとヒントが表示され完了で消えることを検証",
      },
    },
    async ({ page, mount }) => {
      await page.clock.install();
      const component = await mount("App/StalledStream");

      await component.getByLabel("Message").fill("Hello");
      await component.getByRole("button", { name: "Send" }).click();

      // Not shown before the threshold…
      await expect(component.getByTestId("slow-hint")).toBeHidden();
      await page.clock.fastForward(10_000);
      // …shown once streaming has stalled past it.
      await expect(component.getByTestId("slow-hint")).toBeVisible();

      // Completing the stream clears the hint and renders the reply.
      await page.evaluate(() => {
        window.__stream.push("Late reply");
        window.__stream.done();
      });
      await expect(component.getByTestId("message-assistant")).toContainText("Late reply");
      await expect(component.getByTestId("slow-hint")).toBeHidden();
    },
  );
});
