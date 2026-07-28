# llm-dev-cycle-lab

LLM駆動開発の「実装 → ユニットテスト → E2E」サイクルを検証するサンプル。
チャットアプリ(フロント/バックエンド分離)+ 多層テスト構成 + トレース駆動最適化。

**開発方針(必読)**: [docs/POLICY.md](docs/POLICY.md) — エージェントファースト6原則と
テスト層の判定表。テストをどの層に書くかはこの表に従うこと。

## 構成

- `apps/api` — Hono バックエンド。`POST /api/chat` が SSE ストリーミング。LLM は `LLMProvider` インターフェース背後の決定的モック(`MockProvider`)
- `apps/web` — Vite + React チャット UI。`useChat` が SSE を逐次パースして描画
- `e2e` — Playwright。`@feature-*` / `@smoke` / `@backend` / `@quarantine` タグで層別
- `scripts/analyze-trace.mjs` — trace.zip を解析して遅いアクション・ネットワーク・console エラーを Markdown 出力

## コマンド

- `npm run test:unit` — 全ワークスペースのユニットテスト(Vitest)
- `npm run e2e` — E2E 全実行(api/web の dev サーバは Playwright が自動起動)
- `npm run e2e:smoke` — @smoke のみ
- `npm run e2e:perf` — trace: 'on' で全記録(perf レーン)
- `npm run analyze:traces` — trace.zip 群の解析レポート

## 開発サイクル(必読)

機能開発は `/dev-cycle` スキルの手順に従うこと。要点:

1. 仕様と E2E 観点を `specs/<feature>.md` に書いてから着手
2. テスト作成(test-writer)と実装(implementer)は別エージェント・別 worktree で並列
3. 実装エージェントはテストファイル(`**/*.test.ts`, `e2e/tests/**`)を変更してはならない
4. 機能の完了条件は「ユニット + その機能のモック E2E がグリーン」。E2E を後回しにしない
   グリーン後、adversarial-reviewer による反証フェーズ(Phase 2.5)を通す。
   反証が成立したら、反例をテストとして固定してから修正する
5. E2E テストケースは 1 機能につき 正常系1本 + 失敗系2本まで。失敗系は「UI に専用ハンドリングがある失敗」のみ
6. LLM 出力の「品質」を E2E で検証しない(evals レーンの仕事)。E2E は配管のみ

## テストの規約

- 固定待ち(`waitForTimeout`)禁止。web-first assertion を使う
- セレクタは `data-testid` / ロール優先
- E2E はフェーズを `test.step` で構造化し、状態遷移ごとに `snap()`(helpers/snap.ts)で
  ラベル付きスクショを撮る(trace・PRコメントが物語として読めるようにする)
- 最終状態には `toMatchAriaSnapshot` の構造アサーションを1枚置く(内容でなく role と順序)
- コンポーネントテストのデフォルトは Vitest Browser Mode(`apps/web/test-browser/`)。
  `page.clock` / `page.route` / video が必要な場合のみ Playwright CT
  (`src/*.story.tsx` + `e2e/components/`)
- flaky になったテストは `@quarantine` タグを付けて PR レーンから外し、修正 issue を立てる
- 接続情報をテストコードに書かない(実行基盤の差し替えは設定・環境変数で行う)
