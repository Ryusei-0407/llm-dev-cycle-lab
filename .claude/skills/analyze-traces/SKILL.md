---
name: analyze-traces
description: Playwright のトレースから実装の性能問題・不健全な兆候を発見し、改善タスクに落とす。nightly perf レーンの後、またはローカルで性能を調べたいときに使う。
---

# analyze-traces: トレース駆動の最適化サイクル

## トレースの入手

ローカルで取る場合:

```bash
pnpm e2e:perf        # PW_TRACE=on で全テストのトレースを記録
```

CI(nightly perf レーン)の成果物を取る場合:

```bash
gh run list --workflow=nightly.yml --limit 5
gh run download <run-id> --name perf-traces --dir .trace-analysis/
```

## 解析

trace-analyst サブエージェントを起動し、トレースのディレクトリを渡す。
エージェントは `scripts/analyze-trace.mjs` で機械的サマリを取り、それを実装課題に翻訳して
`docs/trace-reports/YYYY-MM-DD.md` にレポートを書く。

## レポート後のアクション(このスキルの本体)

1. レポートの問題点を重要度順にレビューする
2. 対応する項目は **1件ずつ `specs/<improvement>.md` に落とし、/dev-cycle で通常の機能サイクルに投入する**(最適化も機能開発と同じゲートを通す。テストなしの「ついで最適化」をしない)
3. 対応した項目は次回の perf レーン実行後、前回レポートとの数値比較で改善を確認する
4. 悪化検知: 直近レポートと比較して 2倍以上遅くなったアクションがあれば、原因コミットを特定してから対応を決める

## 判断基準

- アクション 500ms 以上、API リクエスト 500ms 以上を「遅い」の初期閾値とする(`--slow-ms=` で調整可)
- console エラーは 0 が正常。警告は既知リストにないものだけ報告
- 「何かを必ず見つける」必要はない。健全なら健全と報告して終了してよい
