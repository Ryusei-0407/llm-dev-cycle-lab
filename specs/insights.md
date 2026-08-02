# Feature: insights — インサイト画面(チケット消化状況の分析)

フェーズ6(最終)。チケットの消化状況を可視化する /insights を追加する。
チャートは **TanStack Charts(@tanstack/charts、アルファ版)** を使う(ユーザー
要望)。アルファ依存のため**バージョンは完全固定**(^ を付けない)。agent 専用。

## ユーザーストーリー

- エージェントとして、チケットの状態・ラベルの分布と解決ペースを一目で把握したい

## サーバー(oRPC)

### 新規 `tickets.insights`(agent 専用。customer は FORBIDDEN、未認証は UNAUTHORIZED)

```ts
// now は決定論のため注入可能(既定 new Date())。store メソッドも同名で追加
input: なし;
output: {
  byStatus: {
    open: number;
    in_progress: number;
    resolved: number;
  }
  byPriority: {
    low: number;
    medium: number;
    high: number;
  }
  unassigned: number; // assignee IS NULL かつ status <> 'resolved'
  byLabel: Array<{ name: string; color: string; count: number }>; // name 昇順・0件のラベルも含む
  resolvedByDay: Array<{ date: string; count: number }>;
  // resolvedByDay: 直近14日(UTC 日付 "YYYY-MM-DD"、今日を含む昇順14要素、
  // 該当なしの日は 0 で埋める)。count = その日に resolved へ変化した
  // status_changed イベント(payload.to = 'resolved')のチケット数。
  // 同一チケットが同日に複数回 resolved になっても 1 と数える
}
```

## UI(/insights、agent 専用)

- サイドバー: Board の下に `data-testid="nav-insights"`「インサイト」
  (**agent のみ** — nav-board と同じ出し分け)
- ページ(AppShell 内・`px-6 py-4`):
  - h1「インサイト」
  - **統計カード列**(横並び・固定幅カード): `data-testid="insight-stat-open"` /
    `insight-stat-in_progress` / `insight-stat-resolved` /
    `insight-stat-unassigned` — 各カードはラベル(未対応/進行中/解決済/未割り当て)
    と数値。数値要素は `data-testid="insight-value"` を併持
  - **チャート2枚**(TanStack Charts、SVG 描画):
    1. `data-testid="insight-chart-trend"` — 解決数の推移(resolvedByDay の
       14日、エリアまたはラインチャート。見た目の詳細は APP_DESIGN のトーン
       に合わせ自由)
    2. `data-testid="insight-chart-labels"` — ラベル別件数(byLabel の
       バーチャート。バー色はラベルの color)
  - アニメーションは無効化する(VRT の決定性。ライブラリ側にアニメーションが
    あれば切る)
- customer が /insights を直接開いた場合は `data-testid="insights-forbidden"`
  を表示(board-forbidden の流儀。リダイレクトしない)
- データ取得は React Query(retry: false)。取得失敗は
  `data-testid="insights-error"`「読み込みに失敗しました。」

## 依存の追加

- TanStack Charts の React 向けパッケージ(名称は npm 上の実配布に従う —
  @tanstack/charts と React アダプタ。**バージョンは exact 固定**)。
  package.json とルートの pnpm-lock.yaml は必ず同時にステージ
- もし現行アルファが React 19 / 本リポジトリの TS 設定でビルド不能な場合は
  **独断で別ライブラリに差し替えず**、その事実を報告して裁定を仰ぐこと

## E2E観点(@feature-insights)

1. @smoke(agent・実バックエンド): サイドバーの nav-insights → /insights で
   h1「インサイト」・統計カード4枚(各 insight-value が数字 /\d+/)・
   チャート2枚(insight-chart-trend / insight-chart-labels 内に svg が可視)
   を確認(共有DBのため数値の絶対値は見ない)
2. 配線の決定性(モックレーン): `page.route` で tickets.insights を固定値
   (byStatus {open:5,in_progress:2,resolved:7}・unassigned 3・
   byLabel auth=4/billing=1/api=0・resolvedByDay は末尾の日 count 2、他 0)に
   スタブ → 統計カードの数値が 5/2/7/3 と表示され、ラベルチャートに
   auth のバー(aria or DOM 上のラベル文字)が現れる
3. customer: nav-insights が**無い**・/insights 直接アクセスで
   insights-forbidden 表示

## component観点(Vitest Browser Mode)

- なし(チャート描画の検証は VRT と E2E スタブレーンが担保)

## unit観点

- store.insights: byStatus/byPriority/unassigned(シード基準)/ byLabel が
  name 昇順で 0 件ラベルも含む / resolvedByDay の 14要素・UTC 日付境界
  (now 注入で日付をまたぐイベントの入る日を固定)/ 同一チケット同日
  複数 resolved の重複排除 / 14日より古いイベントは含まない
- router(HTTP面): 401 / customer FORBIDDEN / agent 200 で形が返る

## feature-map / タグ

- `"insights": ["apps/api/**", "apps/web/src/**", "e2e/tests/insights.spec.ts"]`
- E2E は `@feature-insights`。@smoke は1本のみ。2 はモックレーン

## 備考(実装者向け)

- resolvedByDay の集計は ticket_events を使う(status_changed かつ
  payload->>'to' = 'resolved'。日付は created_at の UTC 日)
- アルファ版 API が不安定なため、チャート実装は薄いラッパコンポーネント
  (components/insight-charts.tsx 等)に隔離し、ページ本体から直接ライブラリ
  API を触らない(将来の差し替えを1ファイルに閉じる)
- aria snapshot を書く場合は CI=1 で照合(ローカル ignoreSnapshots は aria も
  スキップ)
- VRT: /insights の baseline はメインが統合フェーズで追加(visual.spec.ts に
  触れない)
