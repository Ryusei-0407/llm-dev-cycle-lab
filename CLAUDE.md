# llm-dev-cycle-lab

LLM駆動開発の「実装 → テスト → E2E」サイクルを検証するラボ。題材は SSE ストリーミングの
チャットアプリ(`apps/api` = Hono、`apps/web` = Vite+/React、`e2e` = Playwright)。

- 開発方針・テスト層の判定表・テスト規約: `docs/POLICY.md`(テストをどの層に書くか迷ったら読む)
- 機能追加・変更のタスクは `/dev-cycle` スキルの手順に従う

## コマンド

- `npm run test:unit` — ユニット + Vitest Browser Mode(実chromium)の両方が走る
- `npm run e2e` / `npm run e2e -- --grep @feature-<name>` / `npm run e2e -- --last-failed`
- `npm run e2e:perf` → `npm run analyze:traces` — trace 全記録と機械解析
- dev サーバは Playwright が自動起動(手動なら `npm run dev:api` + `npm run dev:web`)

## このリポジトリ特有の注意(踏んだ罠)

- Playwright の `outputDir` / reporter のパスは**設定ファイル基準で明示**する。相対パスは
  cwd 基準で解決され、成果物が想定外の場所に出る(`e2e/playwright.config.ts` 参照)
- Playwright 同梱の ffmpeg は GIF エンコーダを持たない。PRメディア用の GIF 変換には
  実 ffmpeg が必要(CI は apt でインストール)
- TDDゲート(Stop hook)は `.claude/tdd-gate` ファイルの有無で on/off(`touch` / `rm`)
- PRコメントの画像は `ci-media` ブランチ + 同一リポジトリ blob URL(`?raw=true`)方式。
  private リポジトリでもインライン表示される(camo で壊れるのは外部ドメイン画像のみ)
