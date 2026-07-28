# llm-dev-cycle-lab

LLM を用いた開発で「実装 → ユニットテスト → E2E(結合)」のサイクルを検証するラボ。
題材は SSE ストリーミングのチャットアプリ(フロント/バックエンド分離)。

設計の全体像と調査結果は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## セットアップ

[devenv](https://devenv.sh/) が Node.js / pnpm / ffmpeg と pre-commit フック
(oxfmt / oxlint)を提供します:

```bash
devenv shell            # 初回はフックの自動インストールも行われる
pnpm install
pnpm exec playwright install chromium
```

## コマンド

| コマンド                        | 内容                       |
| ------------------------------- | -------------------------- |
| `pnpm dev:api` / `pnpm dev:web` | 開発サーバ(8787 / 5173)    |
| `pnpm test:unit`                | ユニットテスト(Vitest)     |
| `pnpm e2e`                      | E2E 全実行(サーバ自動起動) |
| `pnpm e2e:smoke`                | @smoke のみ                |
| `pnpm e2e:perf`                 | trace 全記録(perf レーン)  |
| `pnpm analyze:traces`           | トレース解析レポート       |

## テストの層構成([docs/POLICY.md](docs/POLICY.md) の判定表参照)

1. **ユニット**(Vitest/node) — 純ロジック
2. **コンポーネント / Vitest Browser Mode**(`apps/web/test-browser/`) — 実ブラウザでしか検証できない挙動(ストリーミング逐次描画等)。componentテストのデフォルト
3. **コンポーネント / Playwright CT**(`src/*.story.tsx` + `e2e/components/`) — BMで不可能なもののみ(`page.clock` 等)
4. **モック E2E**(`@feature-*`) — `page.route()` で API を決定的に固定。全 PR で実行
5. **バックエンド結合**(`@backend`) — 実 API + 決定的モックプロバイダ。構造的アサーションのみ。nightly。実 LLM に切り替えても(環境変数のみで)テストコードは不変
6. **Evals**(未導入) — LLM 出力の品質評価。promptfoo 等を別ジョブで

## Claude Code ワークフロー

- `/dev-cycle` — 機能開発サイクル(仕様化 → test-writer / implementer を worktree 並列 → 機能単位で E2E まで完了 → adversarial-reviewer による反証フェーズ)
- `/analyze-traces` — nightly perf レーンのトレースから改善タスクを抽出
- Stop hook(TDD ゲート): `touch .claude/tdd-gate` で「ユニットテスト全グリーンまでターン終了不可」を有効化
