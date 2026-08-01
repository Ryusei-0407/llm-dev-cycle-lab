# Feature: triage — 受信トレイ(トリアージ)とサーバサイドフィルタ

フェーズ4a。Linear の Triage に相当する「受信トレイ」(未割り当てチケットの
確認・振り分け起点)と、一覧のサーバサイドフィルタ(状態・優先度・ラベル)を
追加する。`tickets.listPage` の入力拡張が唯一の API 変更(新規手続きは
`tickets.inboxCount` のみ)。

## ユーザーストーリー

- エージェントとして、未割り当てのチケットを受信トレイでまとめて確認し、
  そこから振り分けたい(サイドバーに件数バッジ)
- エージェントとして、一覧を状態・優先度・ラベルで絞り込みたい
  (ページネーションと両立するサーバサイドフィルタ)

## サーバー(oRPC)

### `tickets.listPage` の入力拡張(後方互換 — 既存フィールドは不変)

```ts
input: {
  cursor?: string;
  limit?: number;          // 既存どおり 1..100, 既定 50
  status?: "open" | "in_progress" | "resolved";
  priority?: "low" | "medium" | "high";
  label?: string;          // ラベル name。カタログに無い name は空結果(エラーにしない)
  unassigned?: boolean;    // true = assignee_email IS NULL のみ
}
```

- フィルタは WHERE 条件の AND 結合。keyset カーソル・並び(created_at DESC,
  id DESC)・ロールスコープ(customer は自分の分のみ)は既存のまま併用できる
- カーソルはページ位置のみを表す。フィルタを変えて別のフィルタのカーソルを
  渡した場合の結果は未定義でよい(クライアントはフィルタ変更時にカーソルを
  破棄する)
- label フィルタは `EXISTS (ticket_labels ⋈ labels WHERE name = $n)` 相当。
  OFFSET 不使用は既存のまま

### 新規 `tickets.inboxCount`

- input なし → `number`(**agent 専用**。customer は FORBIDDEN)
- 定義: `assignee_email IS NULL AND status <> 'resolved'` の件数
  (= 受信トレイの中身。解決済みはトリアージ不要)

## UI

### サイドバー(AppShell)

- 「Tickets」の上に `data-testid="nav-inbox"` — Link「受信トレイ」→ /inbox
  (**agent のみ**。customer にはレンダリングしない — nav-board と同じ出し分け)
- リンク右端に件数バッジ `data-testid="inbox-count"`(tickets.inboxCount。
  0 のときはバッジ自体を出さない)。`ticket.created` / `ticket.updated` の
  WS 受信で invalidate(既存 realtime 機構に追加)

### 受信トレイ(/inbox、新ルート。agent 専用)

- AppShell 内。h1「受信トレイ」+ 説明文(未割り当てのチケット)
- 中身は `tickets.listPage` の `unassigned: true` + status フィルタなし…ではなく
  **`unassigned: true` かつ resolved を除外**した一覧。listPage には status の
  単一値フィルタしかないため、**inbox は status フィルタを送らず、返却行の
  resolved 除外はサーバ定義に合わせて `unassigned: true` +
  クライアントで resolved を除外**…は並び崩れの元なので採らない。
  → **仕様決定**: listPage に `unresolved?: boolean`(true = status <> 'resolved')
  も追加する(inboxCount と同じ述語を一覧でも使えるように)。inbox は
  `{ unassigned: true, unresolved: true }` で取得する
- 表示は既存 TicketList(仮想化・行 testid そのまま)。0件時は
  `data-testid="inbox-empty"`「受信トレイは空です」
- 行クリック → 既存詳細へ(振り分け = 詳細パネルの assignee-select。
  inbox 専用の割り当て UI は作らない)
- customer が /inbox を直接開いた場合: `data-testid="inbox-forbidden"` を表示
  (board.tsx の board-forbidden と同じ流儀。リダイレクトしない)

### 一覧(/tickets)のフィルタバー

- ヘッダ行(h1 と New ticket の下)にフィルタ行を追加:
  - `data-testid="filter-status"` — select(すべて("")/ Open / In progress / Resolved)
  - `data-testid="filter-priority"` — select(すべて / Low / Medium / High)
  - `data-testid="filter-label"` — select(すべて + カタログの name 一覧。
    カタログは `tickets.labels`(ロール不問)から取得)
  - いずれか有効時のみ `data-testid="filter-clear"`「クリア」ボタン(全解除)
- フィルタ値は **URL search params**(`/tickets?status=open&priority=high&label=auth`)
  に持つ(TanStack Router の validateSearch。リロード・共有で再現可能)
- フィルタ変更でカーソルを破棄して1ページ目から取り直す(useInfiniteQuery の
  query key にフィルタを含める)。仮想化・インフィニティスクロールは併用
- フィルタは両ロールで使える(customer にも表示。ただし unassigned フィルタ UI は
  作らない — 受信トレイ専用)

## E2E観点(@feature-triage、実バックエンド)

1. @smoke(agent): New ticket で自前チケットを作成 → サイドバーの
   nav-inbox(受信トレイ)へ → 作成したチケットの行が見える(未割り当て)→
   行から詳細を開き assignee-select で自分に割り当て → 受信トレイに戻ると
   その行が**消えている**(アンカーは自作 subject。件数アサーションはバッジの
   存在確認まで — 共有DBのため具体数は見ない)。最終状態で app-sidebar に
   aria snapshot(受信トレイリンクを含む)
2. フィルタ(agent): /tickets で filter-priority を High に →
   シードの "Cannot login to dashboard"(high)行が見え、"Billing question"
   (medium)行が**消える** → さらに filter-label を billing に → 両方消えて
   0行(High かつ billing は無い)→ filter-clear で両行復活。URL に
   search param が反映されることも確認
3. customer: サイドバーに nav-inbox が無い・/inbox 直接アクセスで
   inbox-forbidden 表示・/tickets のフィルタバー(filter-status)は使える

## component観点(Vitest Browser Mode)

- なし(フィルタバー・inbox は E2E で薄く担保。TicketList は既存テスト)

## unit観点

- store.listPage フィルタ: status / priority / label / unassigned / unresolved
  それぞれ単独 + 組み合わせ(unassigned+unresolved)+ カーソル併用
  (フィルタ付き2ページ目が正しく続く)+ 未知 label 名は空結果 +
  customer ロールスコープとの併用
- store.inboxCount: 定義どおりの件数(シード基準の相対検証: 割り当て操作の
  前後で減ることなど、絶対数に依存しない形でよい。applySchemaAndSeed 直後は
  シードが固定なので絶対数でも可)
- schema(zod): listPage 新フィールドの検証(不正 enum 拒否・boolean)
- router: inboxCount の agent 専用(customer FORBIDDEN)・listPage フィルタが
  HTTP 面で機能する(1ケースで十分)

## feature-map / タグ

- `"triage": ["apps/api/**", "apps/web/src/**", "e2e/tests/triage.spec.ts"]`
- E2E は `@feature-triage`。@smoke は1本のみ

## 備考(実装者向け)

- visual.spec.ts(VRT)のスタブ・baseline はメインが統合フェーズで更新する
  (一覧にフィルタバーが増えるため)。実装側では visual.spec に触れない
- listPage の WHERE 組み立ては既存の params 配列方式を拡張する(文字列連結で
  SQL を作らない)
- サイドバーのバッジ取得(inboxCount)は agent のときのみ fetch
  (customer は呼ばない — 詳細パネルの agents/labels と同じ enabled ガード。
  E2E がリクエスト計数で見る可能性がある)
