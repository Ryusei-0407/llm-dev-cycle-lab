import { expect, test } from "../fixtures";
import { snap } from "../helpers/snap";

// E2E for copilot-suggest (spec: specs/copilot-suggest.md E2E観点). 提案チップと会話
// クリアの配管を検証する — 回答の質ではなく、チップ表示/クリック送信/クリアによる
// 会話リセットの観測可能な挙動(role と順序、testid の出し分け)をアサートする。
//
// 主経路は実バックエンド(既定のモック provider)を使う。copilot の status 質問は
// プロンプトに <<<STATS>>> を含むため、MockProvider が以下の固定文を返す
// (specs/copilot.md「MockProvider の拡張」・完全一致)。3つの提案チップはいずれも
// status 質問なので、どれをクリックしてもこの固定文がアンカーになる。
const FIXED_LINE =
  "現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。";
// 提案チップの文言(specs/copilot-suggest.md・完全一致で固定)。同一 testid 3つを
// 文言 filter で一意化する(部分一致の多重マッチを避けるため完全一致 exact:true)。
const SUGGESTIONS = [
  "全体のチケットの進行状況は?",
  "未割り当てのチケットはある?",
  "停滞しているチケットは?",
];
// E2E観点 1 が指定するクリック対象。
const CLICKED_SUGGESTION = "未割り当てのチケットはある?";

test.describe("copilot suggest @feature-copilot-suggest", () => {
  test(
    "agent uses a suggestion chip then clears the conversation @smoke",
    {
      annotation: {
        type: "description",
        description:
          "担当者が copilot-launch でパネルを開くと会話が空なので copilot-suggest-heading『よくある質問』と提案チップ3つが見え、『未割り当てのチケットはある?』チップをクリックすると copilot-user に同文言・copilot-assistant に MockProvider の固定文が表示されチップ群が消え、copilot-clear をクリックすると会話が空に戻り提案チップが再表示される主経路を検証",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("Copilot を開くと空状態で提案チップが見える", async () => {
        await page.goto("/tickets");
        await page.getByTestId("copilot-launch").click();
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await expect(page.getByTestId("copilot-suggest-heading")).toContainText("よくある質問");
        // チップは同一 testid 3つ。件数と各文言の存在で確認する。
        await expect(page.getByTestId("copilot-suggestion")).toHaveCount(3);
        for (const text of SUGGESTIONS) {
          await expect(
            page.getByTestId("copilot-suggestion").filter({ hasText: text }),
          ).toBeVisible();
        }
        // 会話が空なのでクリアボタンは無い。
        await expect(page.getByTestId("copilot-clear")).toHaveCount(0);
        await snap(page, testInfo, "空状態で提案チップ");
      });

      await test.step("提案チップをクリックするとその文言が送信される", async () => {
        // 部分一致の多重マッチを避けて対象チップを一意に絞る。
        await page
          .getByTestId("copilot-suggestion")
          .filter({ hasText: CLICKED_SUGGESTION })
          .click();
        await expect(page.getByTestId("copilot-user")).toContainText(CLICKED_SUGGESTION);
        await snap(page, testInfo, "チップで送信");
      });

      await test.step("固定文が表示されチップ群が消える", async () => {
        // 固定待ちは使わず、固定文テキストの出現でストリーミング完了を待つ。
        await expect(page.getByTestId("copilot-assistant")).toContainText(FIXED_LINE);
        await expect(page.getByTestId("copilot-error")).toHaveCount(0);
        // 会話が空でなくなったので提案チップと見出しは非表示。
        await expect(page.getByTestId("copilot-suggestion")).toHaveCount(0);
        await expect(page.getByTestId("copilot-suggest-heading")).toHaveCount(0);
        await snap(page, testInfo, "回答表示・チップ消滅");
      });

      await test.step("クリアで会話が空に戻り提案チップが再表示される", async () => {
        // 会話が1件以上あるのでクリアボタンが出る。
        await page.getByTestId("copilot-clear").click();
        await expect(page.getByTestId("copilot-user")).toHaveCount(0);
        await expect(page.getByTestId("copilot-assistant")).toHaveCount(0);
        await expect(page.getByTestId("copilot-suggest-heading")).toContainText("よくある質問");
        await expect(page.getByTestId("copilot-suggestion")).toHaveCount(3);
        await snap(page, testInfo, "クリアで提案チップ再表示");
      });

      // 構造アサーション: 空状態パネルの骨格(見出し・チップ・入力・送信の role と
      // 順序)を固定する。チップ文言は散文でなく固定だが aria は role/順序のみを見る。
      await expect(page.getByTestId("copilot-panel")).toMatchAriaSnapshot(`
        - heading
        - button
        - button
        - button
        - textbox
        - button
      `);
    },
  );

  test(
    "clearing then sending manually starts a fresh single-turn conversation",
    {
      annotation: {
        type: "description",
        description:
          "提案チップで1往復した会話を copilot-clear でクリアした後、copilot-input から手動で別の質問を送信すると、クリア前の履歴が持ち越されず copilot-user が新しい1件だけ・copilot-assistant が1件だけの新しい会話として表示されることを検証(クリアが会話履歴を確実にリセットする)",
      },
    },
    async ({ page }, testInfo) => {
      await test.step("チップで1往復してからクリアする", async () => {
        await page.goto("/tickets");
        await page.getByTestId("copilot-launch").click();
        await expect(page.getByTestId("copilot-panel")).toBeVisible();
        await page
          .getByTestId("copilot-suggestion")
          .filter({ hasText: CLICKED_SUGGESTION })
          .click();
        await expect(page.getByTestId("copilot-assistant")).toContainText(FIXED_LINE);
        await page.getByTestId("copilot-clear").click();
        await expect(page.getByTestId("copilot-user")).toHaveCount(0);
        await snap(page, testInfo, "クリア後");
      });

      await test.step("入力欄から手動送信すると新しい1往復だけ表示される", async () => {
        const MANUAL = "全体のチケットの進行状況は?";
        await page.getByTestId("copilot-input").fill(MANUAL);
        await page.getByTestId("copilot-send").click();
        // クリア前の発話が持ち越されていないこと: user は新しい1件のみ。
        await expect(page.getByTestId("copilot-user")).toHaveCount(1);
        await expect(page.getByTestId("copilot-user")).toContainText(MANUAL);
        // 固定文の出現でストリーミング完了を待つ。assistant も1件のみ。
        await expect(page.getByTestId("copilot-assistant")).toContainText(FIXED_LINE);
        await expect(page.getByTestId("copilot-assistant")).toHaveCount(1);
        await snap(page, testInfo, "手動送信で新しい会話");
      });
    },
  );
});
