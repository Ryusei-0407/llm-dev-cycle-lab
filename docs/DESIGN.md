# LLM駆動開発サイクルの設計 — 調査と設計判断

このリポジトリは「実装 → ユニットテスト → E2E(結合)」を LLM エージェント前提で
最適化するワークフローの検証環境。本ドキュメントは調査結果と設計判断の記録。

## 1. 全体像

```
[機能サイクル]  仕様化 → (test-writer ∥ implementer, 別worktree) → マージ
                → ユニット green → その機能のモックE2E green = 機能完了
                        ↑ 改善タスクが還流
[PRレーン]      モックE2Eのみ・chromiumのみ・変更パスのみ(目標5分)
[nightly]       フルE2E + @backend結合 (+ 将来: 実LLMスモーク / Evals)
[perfレーン]    trace全記録 → trace-analyst が解析 → 改善タスク化 → 機能サイクルへ
```

## 2. 主要な設計判断と根拠

### 2.1 テスト作成と実装のエージェント分離(非対称権限)

- Anthropic 公式ベストプラクティスが「テストを書く Claude と実装する Claude の分離」を推奨
  (https://code.claude.com/docs/en/best-practices)
- 理由はコンテキスト隔離: 同一コンテキストだと「コードが何をすべきか」でなく
  「何をしているか」を追認するテストになる
- 実装: `.claude/agents/test-writer.md`(実装コードを読まない)/
  `implementer.md`(テストを変更しない)。どちらも `isolation: worktree`
- ルールの強制は3層: skill=ワークフロー定義、agent=隔離実行者、hook=破られないルール
  (Stop hook による TDD ゲート: `scripts/tdd-stop-gate.sh`)
- **敵対的レビュー(Phase 2.5)**: グリーン後、作業に関与していない新規コンテキストの
  `adversarial-reviewer` が「テストを通したまま仕様を破るミューテーション」を実際に試みる。
  worktree 隔離なので破壊的検証が安全。公式ドキュメントの警告(gap を探せと言われた
  レビュアーは必ず何か報告する)への対策として、報告条件を「correctness に影響し
  反例を再現できたもののみ」に制限し、反証失敗=頑健を正常な結果として扱う。
  成立した反証は修正前にテストケースとして固定する(レビューをテスト資産に変換)

### 2.2 非決定的なLLM出力に対するE2E戦略(3層分離)

固定テキスト比較は原理的に成立しない(temperature=0でも推論サーバの動的バッチングで
出力が揺れる: https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)。
定石は関心事の分離:

| 層                             | 検証対象                                      | LLM  | 実行     |
| ------------------------------ | --------------------------------------------- | ---- | -------- |
| モックE2E                      | UIの配管(送信→表示→ストリーム完了→エラー処理) | なし | 全PR     |
| 実LLMスモーク(@backend の延長) | API契約。構造的アサーションのみ               | あり | nightly  |
| Evals(promptfoo等)             | 応答の品質・回帰                              | あり | 別ジョブ |

- 「UIテストと品質評価を1本のPlaywrightテストに混ぜる」のが flaky なAIテストの典型的失敗
- モックは BFF 層(`/api/chat`)に対して行う(ブラウザから見えるのは自社APIのため)
- `route.fulfill()` は一括返却のみ(真のストリーミング再現は不可)。逐次描画の検証は
  実バックエンド+決定的モックプロバイダの @backend テストが担う
- 内容の質をE2Eでどうしても見る場合のみ LLM-as-judge(llm-assert 等)を限定使用

現状: モックのみで完結(Evals・実LLM接続は未導入)。**未検証なのは「実LLMの実挙動」
に依存する部分のみ**: 実プロバイダのSSE形式差異・レイテンシ・タイムアウト、および
LLM-as-judge の判定品質。パイプライン自体は @backend レーンで検証済みで、実LLM化は
プロバイダ実装+環境変数の追加だけでテストコードは不変。

### 2.3 機能単位の漸進的E2E

- E2Eを最終フェーズに後置きしない。機能の完了条件(Definition of Done)に
  「その機能のモックE2Eがグリーン」を含める
- モックE2Eはバックエンド・LLMが未完成でも動くため、機能実装とほぼ同時に書ける
- テストケース選定規律(無限列挙の防止):
  - 正常系: 機能につき1本(主経路のみ)
  - 失敗系: 最大2本。「UIに専用ハンドリングがある失敗」かつ「モックで決定的に再現可能」のみ
  - 3本目が欲しくなったら機能分割のサイン
- タグ(`@feature-*` / `@smoke` / `@backend` / `@quarantine`)で層別し、
  PRレーンの実行時間を機能数に対して一定に保つ

### 2.4 CI実行時間バジェット

優先順: ①実行量を減らす(パスフィルタ、タグ、`--only-changed`)→
②セットアップ削減(ブラウザキャッシュ、chromiumのみ、ビルド再利用)→
③テスト設計(storageState認証、API経由の状態準備、固定待ち禁止)→ ④シャーディング。

- PRレーン目標5分。`--max-failures=5` で早期打ち切り
- flaky は `@quarantine` で隔離し nightly のみ(リトライによる実行時間の倍増を防ぐ)
- 数百テスト・30分以内なら GitHub Actions ネイティブで十分。シャード偏りが問題化したら
  Currents.dev(reporter追加のみ・可逆)を検討

### 2.5 トレース駆動最適化

- trace.zip は NDJSON のイベントログ(アクション時間、ネットワーク、console)であり、
  エージェントが解析できる実装品質の一次データ
- PRレーンは `on-first-retry` のまま(オーバーヘッド回避)。nightly の perf レーンでのみ
  `trace: 'on'` で全記録し、artifact 化
- `scripts/analyze-trace.mjs` が機械的サマリを出し、trace-analyst エージェントが
  実装課題に翻訳、`/analyze-traces` スキルが改善タスクとして機能サイクルに還流させる
- 最適化タスクも通常の機能サイクル(テストつき)で実施する。「ついで最適化」をしない

### 2.6 実行基盤(プロバイダー非依存)

- 原則: **テストコードに接続情報を書かない**。差し替えは設定・環境変数のみ
- 段階: GHAシャーディング(現状・追加コスト0)→ Currents.dev(オーケストレーションのみ
  SaaS化・可逆)→ 大規模時は K8s + 公式イメージ `run-server`(完全OSS、
  `PW_TEST_CONNECT_WS_ENDPOINT` のみ)または Azure Playwright Workspaces($0.01/分〜)
- AWS に同等マネージドはない(Device Farm は Selenium 中心)。旧 Microsoft Playwright
  Testing は2026年3月廃止 → Playwright Workspaces へ(サービス存続リスクは考慮)

### 2.7 PR可視化(無料・OSS構成)

- CI では全テストで動画+最終スクショを記録(スイートが小さいため。時間バジェットを
  圧迫し始めたら失敗時のみに戻す)、trace は on-first-retry のまま
- `daun/playwright-report-summary@v4` で PRコメントにサマリ(同一コメント更新)
- **メディアコメント**(`scripts/pr-media-comment.mjs`): GitHub にはコメントへの
  添付アップロード API が無い(2026年7月現在も未実装)ため、動画を GIF 化し
  `ci-media` ブランチにコミットし、同一リポジトリの blob URL + `?raw=true` で
  コメントに埋め込む(reg-actions と同方式)。この形式は private リポジトリでも
  権限のある閲覧者にはインライン表示される(GitHub がレンダリング時に短命JWT付き
  URL へ書き換える)。camo で壊れるのは外部ドメイン画像の場合のみ。
  テストごとに折りたたみ表示、PR毎に直近3run分のみ保持
- 発展: HTMLレポートの GitHub Pages デプロイ(run毎パス)で「2クリックで動画到達」、
  UI差分は `reg-viz/reg-actions`(外部ストレージ不要)
- 注意: トレース/レポートには認証情報が含まれ得る。公開範囲に留意

### 2.8 Vite 8 + Vite DevTools(検証済み)

- Vite+ のコアはネイティブバイナリで、エンジンは Rolldown ベースの Vite 8 世代
  (バナーは `VITE+ v0.2.6` とだけ表示され vite バージョンは出ない)。dev/build は
  `vp` のまま、DevTools プラグインも `vp dev` 配下で動作する
- `vite@8.1.5` は明示的な devDependency として保持: vitest / plugin-react の
  peer 解決を単一の Vite 8 に揃えるため(明示しないと古い vite が自動解決される)
- DevTools は `DEVTOOLS=1`(`dev:devtools` スクリプト)のときだけプラグインを注入。
  E2E・CI のスクリーンショットにパネルが混入しないための環境変数ゲート
- 接続時にターミナルへ6桁の認証コード(+マジックリンク)が出る。CI や headless では
  この対話認証が制約になる点に注意

## 3. 参考資料(主要のみ)

- Claude Code best practices / worktrees / hooks: https://code.claude.com/docs/en/best-practices
- Devin の自律テスト: https://cognition.com/blog/testing-development
- LLM推論の非決定性: https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
- Evals と テストの分離: https://hamel.dev/blog/posts/evals/
- Playwright CI / sharding / docker: https://playwright.dev/docs/ci-intro
- llm-assert(Playwright用LLMマッチャー): https://github.com/llm-assert/llm-assert
- AI SDK のテスト用モック: https://ai-sdk.dev/docs/ai-sdk-core/testing
- Playwright Workspaces: https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/overview-what-is-microsoft-playwright-workspaces
