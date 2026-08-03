# Feature: copilot-suggest — Copilot の対話作り込み(提案チップと会話操作)

作り込みフェーズ。モック03にあった「続けて質問…」の体験を実装する。
API・プロンプト・provider は**変更しない**(apps/api には触れない)。
対象は apps/web/src/components/copilot-panel.tsx(+ lib/copilot-open.ts が
必要なら)のみ。

## ユーザーストーリー

- エージェントとして、何を聞けるか分かる定型質問チップから1クリックで
  質問したい
- エージェントとして、会話をリセットして新しい話題を始めたい

## UI(copilot-panel.tsx)

### 提案チップ

- 表示位置: メッセージリスト領域。**会話が空のとき**(初期状態・クリア後)に
  見出し `data-testid="copilot-suggest-heading"`「よくある質問」と、チップ3つ:
  - `data-testid="copilot-suggestion"`(3つとも同じ testid。文言で区別):
    1. 「全体のチケットの進行状況は?」
    2. 「未割り当てのチケットはある?」
    3. 「停滞しているチケットは?」
- チップクリック = その文言をそのまま送信(copilot-user に発話が積まれ、
  ストリーミング応答が始まる)。送信後、チップ群は非表示(会話が空でなくなる
  ため)
- 入力欄からの手動送信は現状どおり

### 会話クリア

- パネルヘッダに `data-testid="copilot-clear"`「クリア」ボタン
  (会話が1件以上あるときのみ表示)。クリックで会話履歴を空に戻し、
  提案チップが再表示される。ストリーミング中は disabled
- クリアはパネルの開閉状態・入力欄の下書きに影響しない

### 実装ノート

- useChat の会話リセットは、ChatClient/connection の再生成(useMemo の key を
  変える等)で実現してよい — 手段は自由、上記の観測可能な挙動が契約
- 既存の testid・挙動(copilot-user / copilot-assistant / copilot-error /
  copilot-input / copilot-send / SUP-n 参照リンク / Ctrl+/)は不変

## E2E観点(@feature-copilot-suggest、実バックエンド・モック provider)

1. @smoke(agent): パネルを開く → 「よくある質問」とチップ3つが見える →
   「未割り当てのチケットはある?」チップをクリック → copilot-user に同文言・
   copilot-assistant に MockProvider の固定文が表示され、チップ群が消える →
   copilot-clear で会話が空になりチップが再表示される
2. customer: パネル自体が開けない(copilot-launch 不在)は既存 copilot.spec の
   管轄のため**再検証しない**。この機能の E2E は 1 に加え、
   「クリア後に入力欄から手動送信すると新しい会話として1往復だけ表示される」
   (履歴が持ち越されない)を1本

## component観点(Vitest Browser Mode)

- なし(SSE・グローバル状態に強く結合。E2E で担保)

## unit観点

- なし(API 変更なし)

## feature-map / タグ

- `"copilot-suggest": ["apps/web/src/components/copilot-panel.tsx",
"apps/web/src/lib/copilot-open.ts", "e2e/tests/copilot-suggest.spec.ts"]`
- E2E は `@feature-copilot-suggest`。@smoke は1本のみ

## 備考

- VRT: パネル空状態の見た目が変わる(チップ追加)ため、既存 copilot.png
  baseline の再生成はメインが統合フェーズで行う。visual.spec.ts に触れない
- チップ文言は完全一致でテスト可能に固定(上記3つ)
