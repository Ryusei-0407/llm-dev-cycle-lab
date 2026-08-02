# Feature: copilot — サポート Copilot(チケット横断のヘルプボット)

フェーズ5。どの画面からも開けるドック型チャットで、「全体のチケットの進行状況は?」
のような質問に LLM が答える。**数値はサーバが SQL で集計したスナップショットのみを
根拠にする**(LLM に数えさせない)。ストリーミングは既存の SSE / provider 基盤
(specs/chat.md・reply-draft.md の流儀)を再利用する。agent 専用。

## ユーザーストーリー

- エージェントとして、状況把握の質問(進行状況・未割り当て・停滞)に
  自然言語で即答してほしい
- エージェントとして、回答中のチケット参照(SUP-n)からそのままジャンプしたい

## サーバー

### スナップショット(store 追加メソッド `copilotSnapshot`)

```ts
// now は決定論のため注入可能(既定 new Date())
async copilotSnapshot(now?: Date): Promise<CopilotSnapshot>

type CopilotSnapshot = {
  byStatus: { open: number; in_progress: number; resolved: number };
  byPriority: { low: number; medium: number; high: number };
  unassigned: number;            // assignee IS NULL かつ status <> 'resolved'
  resolvedLast7d: number;        // status='resolved' かつ updated_at >= now-7d
  stale: Array<{ number: number; subject: string; status: string }>;
  // stale = 未解決かつ updated_at <= now-48h。updated_at ASC で最大5件
};
```

### SSE ルート `POST /api/copilot/chat`(Hono、oRPC ではない)

- reply-draft(/api/tickets/draft)と同じ @tanstack/ai の SSE ワイヤ。
  クライアントの `messages` を会話履歴として受け取る
- **agent 専用**: セッション無しは 401、customer は 403(reply-draft の
  authz 流儀)
- 生成前に copilotSnapshot を取り、システム指示 + スナップショット JSON +
  会話を1つのプロンプトに合成して provider.stream に渡す。システム指示の要点:
  「数値はスナップショットの値だけを使う。チケット参照は必ず SUP-{number}
  形式。日本語で簡潔に」
- プロンプト内のスナップショットは `<<<STATS>>> ... <<<END_STATS>>>` で
  区切る(evals の judge がアンカーにする。ユーザー入力側に同一区切り文字が
  現れた場合は evals/judge と同じ流儀で中和する)

### MockProvider の拡張

- プロンプトに `<<<STATS>>>` を含むリクエストには、以下の固定文を
  ストリームで返す(E2E のアンカー。文言は完全一致で固定):

```
現在の状況の概要です。未対応と進行中の対応状況はダッシュボードの通りです。停滞していれば SUP-1 の確認をおすすめします。
```

## UI(agent 専用)

- サイドバー下端(current-user の上)に `data-testid="copilot-launch"`
  「Copilot に質問…」ボタン。**Ctrl+/ (⌘/)** のショートカットでも開閉
  (AppShell のリスナに追加)。customer にはボタンを出さずショートカットも
  無効
- ドックパネル `data-testid="copilot-panel"`: メインペイン右下に固定
  (fixed・w-96・max-h-[70dvh]・surface-3・閉じるボタン
  `data-testid="copilot-close"`)。ルート遷移しても開いたまま(AppShell 直下)
- 中身:
  - メッセージリスト: ユーザー発話 `data-testid="copilot-user"` /
    アシスタント `data-testid="copilot-assistant"`(ストリーミング逐次表示。
    useChat + fetchServerSentEvents — draft-panel の流儀)
  - 回答テキスト中の `SUP-\d+` は `data-testid="copilot-ref"` のリンクとして
    描画し、クリックで `tickets.search`(既存)で解決した先頭ヒットの
    詳細 `/tickets/{id}` へ遷移する(ヒットなしは何もしない)
  - 入力欄 `data-testid="copilot-input"`(placeholder「チケットについて質問…」)+
    送信 `data-testid="copilot-send"`(Enter 送信可)
  - エラー時 `data-testid="copilot-error"`「回答の取得に失敗しました。」

## E2E観点(@feature-copilot)

1. @smoke(agent・モック provider): copilot-launch でパネルを開く →
   「全体のチケットの進行状況は?」を送信 → copilot-user に質問が出る →
   copilot-assistant に MockProvider の固定文(上記)が表示される →
   文中の `SUP-1`(copilot-ref)をクリック → SUP-1 の詳細
   (subject "Cannot login to dashboard")に遷移し、パネルは開いたまま
2. 失敗系(agent): `page.route` で /api/copilot/chat を 500 に →
   送信後 copilot-error 表示
3. customer: サイドバーに copilot-launch が**無い**。`request` で
   /api/copilot/chat を customer セッションで直接 POST すると 403

## component観点(Vitest Browser Mode)

- なし(SSE・ルーター・グローバルキーに強く結合。E2E とunit で担保)

## unit観点

- store.copilotSnapshot: now 注入でシード基準の各数値
  (byStatus/byPriority/unassigned)・resolvedLast7d の 7日境界・stale の
  48h境界と updated_at ASC・最大5件
- route(HTTP面): 401(未認証)/ 403(customer)/ agent で SSE 応答が返り、
  provider に渡ったプロンプトが `<<<STATS>>>` 区切りと正しい集計値を含む
  (注入 provider でプロンプトをキャプチャ — evals/run の deps 注入の流儀)/
  ユーザー入力中の `<<<STATS>>>` が中和される
- MockProvider: `<<<STATS>>>` 含みプロンプトへの固定文(完全一致)

## evals(nightly への追加)

- apps/api/evals/cases に copilot ケースを1件追加: 固定スナップショット
  (JSON をケースに埋める)+ 質問「全体のチケットの進行状況は?」。
  judge 観点: 回答中の数値がスナップショットの値と矛盾しない・SUP-n 形式で
  参照する・日本語。既存の judge/run 基盤をそのまま使う(実行回数の増加は
  1ケース分 — free tier 20req/day 内)

## feature-map / タグ

- `"copilot": ["apps/api/**", "apps/web/src/**", "e2e/tests/copilot.spec.ts"]`
- E2E は `@feature-copilot`。@smoke は1本のみ。3本とも実バックエンド
  (LLM はモック provider。E2E 環境は既定でモック)

## 備考(実装者向け)

- 新規依存の追加は不要(禁止)。SSE は reply-draft(apps/api/src/tickets/
  draft.ts)の実装流儀を再利用してよい
- aria snapshot を書く場合はローカルの ignoreSnapshots が aria も
  スキップする点に注意(検証は `CI=1 DISABLE_STEP_OVERLAY=1 pnpm e2e --grep ...`)
- VRT: パネル開状態の baseline はメインが統合フェーズで追加する
  (visual.spec.ts に触れない)。SSE の逐次表示は VRT に不向きなので、
  VRT では入力前の空パネルのみを固定する予定
