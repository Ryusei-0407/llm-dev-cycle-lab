# bulk-actions: 一覧の複数選択と一括変更

## ユーザーストーリー

agent として、/tickets の一覧で複数チケットをチェックボックスで選択し、まとめて
status / priority / 担当者 を変更したい。適用は全件成功か全件不適用(途中まで
適用された中途半端な状態を作らない)。customer には選択 UI を一切出さない。

## 公開インターフェース(oRPC、tickets ルータに追加)

ワイヤは既存と同じ `{"json": <入出力>}` 封筒。**セッション必須 + agent 専用**
(未認証 UNAUTHORIZED / customer は FORBIDDEN)。

- `tickets.bulkUpdate` 入力:

```ts
{
  ids: string[];              // uuid、min 1 / max 50(zod)
  patch: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeEmail?: string | null;   // null = 担当解除
  };                          // 少なくとも1キー必須(.refine)
}
```

- 出力: `{ updated: number }`(**実際に値が変わった**チケット数)
- セマンティクス:
  - **単一トランザクション**。ids に存在しないチケットが1つでも含まれれば
    NOT_FOUND で**全体 rollback**(部分適用しない)
  - フィールド毎に既存の単発ミューテーションと同じ規約:
    同値のチケットは**イベント無し・updated_at 据え置き**(no-op)。
    実変更のあったチケットにはフィールド対応のイベント
    (status_changed / priority_changed / assignee_changed、actor = セッション email、
    payload は既存と同形 `{from, to}`)を記録し updated_at を bump
  - 実変更のあったチケット毎に realtime broadcast `{type:"ticket.updated", ticketId}`
    (no-op のチケットには broadcast しない)
- ワイヤ例(実値):

```
POST /api/rpc/tickets/bulkUpdate
body: {"json":{"ids":["<uuid1>","<uuid2>"],"patch":{"status":"in_progress"}}}
200:  {"json":{"updated":2}}
```

## UI(apps/web/src/routes/tickets.tsx + apps/web/src/components/ticket-list.tsx)

- **選択チェックボックス**: agent のとき、一覧行 grid の先頭(SUP-n 列の左)に
  checkbox 列を追加。`data-testid="ticket-select"`、
  `aria-label="Select <subject>"`。クリックしても行の詳細 Link には遷移しない。
  customer には checkbox を出さない(列は空 span で保持し、ロール差でレイアウトが
  崩れないこと — 既存 grid の流儀)
- **一括アクションバー**: 選択件数 > 0 のとき、一覧下部に固定バー
  `data-testid="bulk-bar"` を表示:
  - `data-testid="bulk-count"` — 「N件選択」
  - `data-testid="bulk-status-select"` — 空(変更しない)/ Open / In progress / Resolved
  - `data-testid="bulk-priority-select"` — 空 / Low / Medium / High
  - `data-testid="bulk-assignee-select"` — 空(変更しない)/ 担当解除 / agent 一覧
    (既存 `tickets.agents` の結果。解除は value="unassign" 等の専用値で null に変換)
  - `data-testid="bulk-apply"` — 適用ボタン。**どのセレクトも空のときは disabled**
  - `data-testid="bulk-clear"` — 選択を全解除しバーを閉じる
- 適用成功: 選択解除・バー消滅・一覧が更新される(リスト query invalidate)
- 適用失敗(API エラー): `data-testid="bulk-error"`(role="alert")
  「一括更新に失敗しました。」を表示し、**選択状態は維持**(リトライ可能)
- ページ遷移・フィルタ変更で選択は破棄されてよい(仕様として保証しない)

## テスト観点(層割り当て)

- **unit(apps/api/test/)**:
  - store.bulkUpdate — ①2件更新で updated=2・各チケットにイベント1件ずつ
    ②同値混在(1件は既に in_progress)で updated=1・no-op 側はイベント無し+
    updated_at 据え置き ③不在 id 混在で NOT_FOUND・**全件据え置き(rollback)**
    ④assigneeEmail: null で解除・assignee_changed 記録
  - zod — ids 空配列 / 51件 / patch 空オブジェクトが弾かれる
  - router — customer が FORBIDDEN、未認証が UNAUTHORIZED。
    broadcast が実変更チケット分だけ発火(録音 hub 注入、no-op は発火しない)
- **E2E 正常1(@smoke)**: agent がテスト内で作成した2件を選択 → bulk-status-select
  で In progress → 適用 → 両行の StatusBadge が In progress・選択解除・bulk-bar 消滅
- **E2E 失敗2**:
  1. `page.route` で bulkUpdate を 500 に → bulk-error 表示・行のバッジ据え置き・
     選択状態維持(bulk-bar が出たまま)
  2. customer セッション: 一覧に ticket-select が 0 件 + `request` で bulkUpdate
     直 POST → FORBIDDEN
- タグ: `@feature-bulk-actions`。feature-map.json に登録:
  `"bulk-actions": ["apps/api/src/tickets/store.ts", "apps/api/src/tickets/router.ts",
"apps/api/src/tickets/schema.ts", "apps/web/src/components/ticket-list.tsx",
"apps/web/src/routes/tickets.tsx", "e2e/tests/bulk-actions.spec.ts"]`

## 実装メモ(制約)

- 既存の単発ミューテーション(setStatus / setPriority / setAssignee)の挙動・契約は
  変更しない。bulkUpdate はそれらと同じイベント/no-op 規約を store 内で共有する
- ticket-list の仮想化(行高 48px 固定・absolute 配置)と既存 testid
  (ticket-row / ticket-link / ticket-status-select 等)を壊さない
- E2E は共有シードを変更しない(アンカー型)。対象チケットはテスト内で API 作成
  (subject 一意)
