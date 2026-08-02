# AIサポートデスク(構築中)

SSE ストリーミングのチャットを土台に AIサポートデスクを構築中のリポジトリ。元は
LLM駆動開発の「実装 → テスト → E2E」サイクルを検証するラボで、その基盤は引き続き有効。
スタックは `apps/api` = Hono、`apps/web` = Vite+/React(TanStack Router + React Query、
Tailwind v4 + shadcn/Base UI)、`e2e` = Playwright。

- 開発方針・テスト層の判定表・テスト規約: `docs/POLICY.md`(テストをどの層に書くか迷ったら読む)
- ビジュアルデザイン仕様(Linear 風・ダーク固定のトークン): `docs/APP_DESIGN.md`
- 機能追加・変更のタスクは `/dev-cycle` スキルの手順に従う

## コマンド

- `pnpm check` — fmt + lint + 型チェックを一括(vp check、1秒以内)。編集後はまずこれ
- `pnpm test:unit` — ユニット + Vitest Browser Mode(実chromium)の両方が走る
- `pnpm e2e` / `pnpm e2e --grep @feature-<name>` / `pnpm e2e --last-failed`
- `pnpm e2e:perf` → `pnpm analyze:traces` — trace 全記録と機械解析
- dev サーバは Playwright が自動起動(手動なら `pnpm dev:api` + `pnpm dev:web`)
- ポートは環境変数化済み: `WEB_PORT`(既定5173)/ `API_PORT`(既定8787)。並列 worktree で
  E2E を同時実行するときは両方を別値にする(例 `WEB_PORT=6173 API_PORT=9787 pnpm e2e`)

## 作業スタイル

- 要求されたことを要求された範囲で完了させれば十分。追加でやると良さそうなことを
  見つけたら、完了報告に提案として添えて次の指示を待つ
- **PR は機能単位(1機能 = 1ブランチ = 1PR)**。ここでの「機能」は feature-map /
  `@feature-<name>` タグの単位。バグ修正でも対象機能が異なれば PR を分ける
  (同時に依頼されても、CI やレビューの効率を理由にまとめない)。テスト・VRT・
  レビューの対応関係が機能ごとに閉じることが、この開発サイクルの検証単位
- コメントは普遍的な内容(外部制約、非自明な理由、数値の根拠)だけを書く。
  修正の経緯・出所はコミットメッセージへ。コメントが長文になりそうなときは、
  先に処理ロジック側の改善余地を疑う

## このリポジトリ特有の注意(踏んだ罠)

- Playwright の `outputDir` / reporter のパスは**設定ファイル基準で明示**する。相対パスは
  cwd 基準で解決され、成果物が想定外の場所に出る(`e2e/playwright.config.ts` 参照)
- Playwright 同梱の ffmpeg は GIF エンコーダを持たない。PRメディア用の GIF 変換には
  実 ffmpeg が必要(CI は apt でインストール)
- TDDゲート(Stop hook)は `.claude/tdd-gate` ファイルの有無で on/off(`touch` / `rm`)
- PRコメントの画像は `ci-media` ブランチ + 同一リポジトリ blob URL(`?raw=true`)方式。
  private リポジトリでもインライン表示される(camo で壊れるのは外部ドメイン画像のみ)
- ルーティングは TanStack Router の file-based(`apps/web/src/routes/`)。route ツリーは
  `src/routeTree.gen.ts` に自動生成される(`vp dev` / `vp build` の router-plugin が生成)。
  コミット対象だが自動生成物なので `.prettierignore` で整形対象外(lint/型はファイル先頭の
  `@ts-nocheck` で除外)。ルート追加時は dev/build を一度回して再生成すること
- VRT(visual.spec.ts)の baseline は **linux(CI)でのみ生成・比較**。ローカルは
  `ignoreSnapshots` で比較スキップ(darwin はフォント差で必ずずれる)。意図した UI 変更で
  baseline を更新するときは `gh workflow run update-snapshots.yml --ref <branch>`(再生成
  コミットがブランチに積まれ、PR の Files タブが新旧画像ビューアになる)。VRT の表示データは
  page.route で固定してあり、DBの状態に依存しない
- shadcn は Base UI ベース(components.json の `style: base-nova`)。コンポーネント追加は
  `apps/web` を cwd にして `pnpm dlx shadcn@latest add <name>`。テーマは `src/styles.css` の
  `:root, .dark`(docs/APP_DESIGN.md 由来)。ダーク固定(`index.html` の `<html class="dark">`)
