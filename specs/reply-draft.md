# Feature: reply-draft(TanStack AI)

チケット詳細ページで、LLM がスレッド文脈から返信ドラフトを生成する。
**TanStack AI(beta)を採用**(@tanstack/ai + @tanstack/ai-react + @tanstack/ai-gemini、バージョン固定)。
既存のチャットページ(/、/api/chat)は本機能では変更しない。

## サーバー契約

- `POST /api/tickets/draft` body `{ ticketId }`(zod 検証、認証セッション必須 — 無ければ 401)
- サーバーは ticket + messages を読み、システムプロンプト(サポート担当としての返信ドラフト作成指示
  - チケット主題 + スレッド履歴)を組み立てて TanStack AI の `chat()` を実行し、
    `toServerSentEventsResponse(...)` の Response をそのまま返す(Hono と Web 標準 Response で整合)
- アダプタ選択は既存 LLM_PROVIDER 方式を踏襲:
  - `mock`(既定): **自作の決定的 mock アダプタ**(TanStack AI の adapter インターフェース準拠)。
    出力は `Draft reply for "{subject}": Thanks for reaching out. ...` の固定文を数チャンクで送出
  - `gemini`: `@tanstack/ai-gemini` の text アダプタ、モデルは GEMINI_MODEL(既定 gemini-flash-latest)
  - gemini 指定 + キー無しは 500 provider_misconfigured(既存ガードの流儀)
- ticket 不在は 404

## UI(tickets.$id ページに追加)

- button "Generate draft"(data-testid="generate-draft")→ @tanstack/ai-react の `useChat`
  (接続先 /api/tickets/draft、SSE)でドラフトをストリーミング表示(data-testid="draft-panel")
- 生成中インジケータ(data-testid="draft-streaming")、完了後 button "Use draft"(data-testid="use-draft")
  → Reply textarea に全文転写(既存入力は上書き)。エラーは data-testid="draft-error"
- Linear テーマ準拠(draft-panel は surface-1 カード)

## E2E観点(@feature-reply-draft、モックアダプタで決定的)

- 正常: 詳細ページ → Generate draft → draft-panel に固定文全文 → Use draft → textarea に転写
- 失敗1: /api/tickets/draft を page.route で 500 → draft-error 表示
- 失敗2: SSE 途中でエラー(route で不完全ストリーム)→ draft-error 表示(部分文があれば保持)
- @backend 1本(nightly): LLM_SMOKE=1 で実 Gemini によるドラフト生成の構造検証
  (draft-panel が空でなく draft-error が無い。内容は検証しない)

## unit観点

- プロンプト組み立て(subject + スレッドが含まれる)/ mock アダプタの決定性 /
  ticketId zod 検証 / 未認証 401 / ticket 不在 404

## 注意

- TanStack AI は 0.x(beta)。パッケージは **バージョン固定**(^ を使わない)
- useChat の SSE 接続が既存の snap()/E2E 防衛(モック強制)と干渉しないこと
- 撤退パス: TanStack AI が Hono/SSE で成立しない場合は自前 SSE(既存 /api/chat の流儀)に
  切り替え、その判断と理由を報告(仕様側で撤退を認める)
