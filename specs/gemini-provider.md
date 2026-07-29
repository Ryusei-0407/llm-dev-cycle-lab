# Feature: gemini-provider

チャットの LLM を実 Gemini に切り替え可能にする。デフォルトは従来どおり決定的モック。
実LLMスモークレーン(nightly)の土台。

## プロバイダ選択(apps/api)

- `LLM_PROVIDER` 環境変数で選択: `mock`(デフォルト・未設定時)/ `gemini`
- `gemini` 指定時に `GEMINI_API_KEY` が無ければ **500 `{error: "provider_misconfigured"}`**
  (フォールバックで黙ってモックにしない — nightly スモークがモックで偽緑になるのを防ぐ)

## GeminiProvider(apps/api/src/llm/gemini.ts)

- `LLMProvider` インターフェースを実装(`stream(messages): AsyncIterable<string>`)
- SDK: `@google/genai`(公式)。モデル: `GEMINI_MODEL` 環境変数(デフォルト `gemini-flash-latest` — 常に現行世代を指すエイリアス。固定名はキーの世代によって提供終了 404 になるため使わない)
- messages(role user/assistant)を Gemini の contents 形式に変換して streaming 呼び出し、
  チャンクの text を delta として yield
- ストリーム中のAPIエラーは throw(既存 app.ts の catch → `stream_failed` イベットに載る)
- **テスト容易性**: コンストラクタでクライアント(または streaming 関数)を注入可能にし、
  unit テストは偽クライアントで delta 変換・エラー伝播を検証(実ネットワーク禁止)

## 起動と env の読み込み

- dotenv は使用禁止(.env が 1Password の FIFO マウントのため)
- apps/api の dev スクリプトを `node --env-file-if-exists=.env --import tsx src/index.ts` に変更
  (.env が無い CI でもエラーにならない。--env-file-if-exists は検証済み)

## テストレーンの防衛(e2e/playwright.config.ts)

- webServer(api)の env で `LLM_PROVIDER` を強制:
  `LLM_SMOKE === "1"` のときだけ `gemini`、それ以外は常に `mock`
  (ローカルの .env に LLM_PROVIDER=gemini が入っていても、通常のE2Eは必ずモックで走る)

## nightly 実LLMスモーク(.github/workflows/nightly.yml)

- 新ジョブ `llm-smoke`: `LLM_SMOKE=1` + `GEMINI_API_KEY`(GitHub Secrets)で
  `--grep @backend` のみ実行(構造的アサーションのテスト2本。テストコードは無変更が設計上の約束)
- タイムアウトを長め(テスト側は typing-indicator 30s 許容済み)、リトライなし

## unit観点(apps/api/test/)

- プロバイダ選択: 未設定→mock / mock→mock / gemini+キー有→gemini / gemini+キー無→ /api/chat が 500 provider_misconfigured
- GeminiProvider: 偽クライアント注入で (a) チャンクtext→delta 変換 (b) 空チャンク(text無し)はskip (c) 途中エラーがthrowされる
- messages→contents 変換(role マッピング)

## E2E観点

- **新規E2Eなし**。既存 @backend 2本が「実LLMに切り替えてもテストコード不変」という設計の検証対象そのもの
- DoD で LLM_SMOKE=1 のローカル実行(実Gemini)により @backend 2本が緑になることを1回実証する
