# 開発方針: エージェントファースト

このリポジトリの最適化対象は「Claude Code(エージェント)が円滑に開発できること」。
人間向けの見やすさ(PRのスクショ/録画等)は、エージェントが使う証跡からの自動生成物として
提供する。以下の原則はすべてこの一点から導出される。

## 原則

### 1. フィードバックは速く、機械可読に

エージェントの開発速度は「変更 → 検証 → 自己修正」ループの速度で決まる。
全検証はワンコマンドで実行でき、結果は構造化された形式(results.json、exit code、
grep可能な出力)で得られること。

- `pnpm test:unit` / `pnpm e2e --grep @feature-x` / `pnpm e2e --last-failed`
- PRレーン5分以内・fail fast(`--max-failures=5`)は人間のためではなく、
  エージェントの修正ループを速くするための制約でもある

### 2. 証跡は「再実行不要」なレベルで残す

失敗の診断に再現実行が必要な状態を作らない。CI run はそれ自体で診断可能であること。

- trace(アクション・ネットワーク・console の時系列)、動画、段階スクショ、
  test.step によるステップ構造 — これらは**エージェントが読む一次データ**
- `scripts/analyze-trace.mjs` で trace は機械可読なサマリになる
- 人間向けのPRメディアコメントは、この同じ証跡の変換であり二重管理しない(原則5)

### 3. ルールは3層で強制する(指示より構造)

- **skill** = 手順とゲートの定義(dev-cycle / analyze-traces)
- **agent** = コンテキスト隔離された実行者(test-writer / implementer / adversarial-reviewer / trace-analyst)
- **hook** = 破られないルール(TDDストップゲート)

LLMへの「お願い」は忘れられる。守らせたいものは構造(hook、権限、ディレクトリ分離)にする。

検証ループは4形態で配置する(どこで何を検証するかの対応):

| 形態                  | 実装                                                                     | 対象                           |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| embedded(生成と同時)  | test-writer の RED 確認 + verify-conventions、implementer のグリーン確認 | 作った直後の自己検証           |
| chained(完了時に連鎖) | dev-cycle: グリーン → 反証(adversarial-reviewer) → smoke → PR            | フェーズ間の検証済みハンドオフ |
| standalone(随時)      | /verify-conventions、/analyze-traces                                     | 横断的な監査                   |
| PR gate(全PR強制)     | CI: check(fmt/lint/型/規約)+ unit + e2e、TDD stop hook                   | 作者の注意深さに依存しない下限 |

### 4. テストは層で分け、各層の責務を越えない

| 層                                                 | 実行                            | 対象                                                                                                                         | 判定基準                                                                                 |
| -------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| unit                                               | `vp test`(node)                 | 純ロジック(パーサ、reducer、APIルート)                                                                                       | ブラウザ不要ならここ。最速                                                               |
| component / **Vitest Browser Mode**                | `vp test`(chromium)             | 実ブラウザでしか検証できないコンポーネント挙動: ストリーミング逐次描画、スクロール、フォーカス                               | **componentテストのデフォルト**。fetch はページ内スタブ(`vi.stubGlobal`)                 |
| component / **Playwright CT**(stories & galleries) | `pnpm e2e --project=components` | BMでは不可能・不安定なもの**のみ**: `page.clock`(実タイマー制御)、`page.route`、video/trace 証跡が必要な場合、マルチフレーム | 例外レイヤ。story(`src/*.story.tsx`)が環境を所有し、テストはページ越しに観測する         |
| E2E                                                | `pnpm e2e`(chromium project)    | ユーザーストーリーの配管(送信→表示→完了→エラー)                                                                              | 機能につき正常1+失敗2まで(反証固定テストは例外)。内容でなく構造をアサート(aria snapshot) |
| @backend                                           | nightly                         | 実バックエンド結合 → 将来は実LLMスモーク                                                                                     | 構造的アサーションのみ                                                                   |
| evals                                              | 未導入                          | LLM出力の品質                                                                                                                | E2Eに品質検証を混ぜない                                                                  |

迷ったら上の層(速い方)へ。下の層は上の層で書けない検証だけを持つ。

**共通規約**(全層):

- 固定待ち(`waitForTimeout`)禁止。web-first assertion / `expect.element` を使う
- セレクタは `data-testid` / ロール優先
- E2E はフェーズを `test.step` で構造化し、状態遷移ごとに `snap()`(e2e/helpers/snap.ts)で
  ラベル付きスクショを撮る。最終状態に `toMatchAriaSnapshot`(role と順序のみ)を1枚置く
- E2E 本数は機能につき正常1+失敗2まで。失敗系は「UIに専用ハンドリングがある失敗」のみ。
  反証フェーズで固定されたテストは上限に数えない
- タグ: `@feature-<name>`(必須)/ `@smoke`(主経路)/ `@backend`(nightly)/
  `@component`(CT)/ `@quarantine`(flaky隔離、nightlyのみ・ゲート外)/
  `@pinned`(反証フェーズで固定されたテスト。E2E本数上限の免除根拠)
- 接続情報・環境依存の値をテストコードに書かない(設定・環境変数で差し替え可能に保つ)

この規約のうち決定論的に判定できるものは `scripts/verify-conventions.mjs` が
機械的に強制する(`pnpm check`・pre-commit・CI に組み込み済み)。規約を増やすときは
ルールも同時に足す(規約とルールの乖離を作らない)。

### 5. 人間向け可視化は証跡から自動生成する

PRメディアコメント(録画GIF・段階スクショ)、サマリコメント、Job Summary は
すべて results.json / test-results から生成される。手作業のスクショ添付や
別撮りを要求するプロセスを作らない。

### 6. ツール最小主義

Playwright と Vite+(バンドルされた Vitest 4 / oxlint / oxfmt)の機能を使い切ってから
外部ツールを検討する。外部ツールを足すのは「接続部の差し替えだけで外せる」形
(reporter、環境変数、設定ファイル)に限る。

## エージェントの開発ループ(推奨コマンド)

| 状況                     | コマンド                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| 編集直後の最速検証(1秒)  | `pnpm check`(fmt + lint + 型を一括)                                 |
| ロジック変更後の最速確認 | `pnpm test:unit`                                                    |
| 機能単位のE2E            | `pnpm e2e --grep @feature-<name>`                                   |
| 直前の失敗だけ再実行     | `pnpm e2e --last-failed`                                            |
| 対話的デバッグ(人間)     | `pnpm exec playwright test --ui`(タグフィルタ+watch+タイムトラベル) |
| trace の機械解析         | `pnpm e2e:perf && pnpm analyze:traces`                              |
| 失敗 trace の目視        | `pnpm exec playwright show-trace e2e/test-results/<dir>/trace.zip`  |
