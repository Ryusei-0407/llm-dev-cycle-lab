# Feature: set-priority — 優先度の変更

作り込みフェーズ。詳細パネルの「優先度」を表示のみから変更可能にする
(specs/detail-panel.md で「変更 API が無いので表示のみ」と保留していた箇所)。
既存の setStatus / setAssignee と同じ作法で揃える。

## ユーザーストーリー

- エージェントとして、チケットの優先度をプロパティパネルから変更し、
  履歴(イベント)にも残したい

## サーバー(oRPC)

### 新規 `tickets.setPriority`

```ts
input: { id: string, priority: "low" | "medium" | "high" }
output: Ticket
```

- **agent 専用**(customer は FORBIDDEN)。存在しない id は NOT_FOUND
- 同値への変更はイベント・updated_at 更新・配信なしで成功(setStatus と同じ)
- 変更成功時: `priority_changed` イベント記録 + updated_at 更新 +
  `ticket.updated` ブロードキャスト。イベント記録と本体 UPDATE は同一
  トランザクション
- store メソッド `setPriority(id, priority, actorEmail?)`(actorEmail 省略時
  "system" — setStatus と同じシグネチャ規約)

### イベント種の追加

- `ticket_events.type` の CHECK 制約に `priority_changed` を追加(schema.sql)
- ワイヤ `TicketEvent.type` に `"priority_changed"` を追加。payload は
  `{ from: "low"|"medium"|"high", to: 同 }`

## UI

- **詳細パネルの優先度行**(components/ticket-properties.tsx):
  - agent: `data-testid="priority-select"` のセレクト(Low / Medium / High、
    value は生値)。変更で `onPriorityChange(priority)` コールバック
    (TicketProperties の公開 props に追加。ルートが setPriority ミューテーション
    - detail invalidate を配線 — assignee と同じ)
  - customer: 現状どおりテキスト表示のみ(capitalize)
- **イベント行の文言**(components/message-thread.tsx):
  `優先度: {from} → {to}`(生値。既存 status/assignee/labels の形式に合わせ
  完全一致で固定)

## E2E観点(@feature-set-priority、実バックエンド)

1. @smoke(agent): New ticket で自前チケット作成(medium で作られる)→ 詳細
   → priority-select で high に変更 → イベント行 `優先度: medium → high` が
   現れ、一覧に戻ると当該行の優先度表示が High
2. customer: 自分のシードチケット詳細に priority-select が**無い**(テキスト
   表示はある)。さらに request で /api/rpc/tickets/setPriority を直接 POST
   すると FORBIDDEN(403)

## component観点(Vitest Browser Mode)

- TicketProperties: agent で priority-select が出て変更で onPriorityChange が
  生値で呼ばれる / customer はテキストのみ(既存 ticket-properties.test.tsx に
  追加する形でよい — 既存テストの変更は onPriorityChange props 追加への型追従のみ可)
- MessageThread: `優先度: low → high` 文言レンダリング(既存
  ticket-model-events.test.tsx への追加でよい)

## unit観点

- store.setPriority: 変更・イベント記録(payload from/to)・updated_at 更新・
  同値スキップ・NotFoundError・トランザクション原子性(poisoned pool の流儀 —
  apps/api/test/ticket-model-atomicity.test.ts 参照)
- schema(zod): setPriorityInput の検証(不正 enum 拒否)
- router(HTTP面): 401 / customer FORBIDDEN / agent 200 / NOT_FOUND /
  `ticket.updated` ブロードキャスト(変更時のみ・同値抑止 —
  ticket-model-broadcast.test.ts の createApp({hub}) 流儀)

## feature-map / タグ

- `"set-priority": ["apps/api/src/tickets/store.ts", "apps/api/src/tickets/router.ts",
"apps/api/src/tickets/schema.ts", "apps/api/db/schema.sql",
"apps/web/src/components/ticket-properties.tsx",
"apps/web/src/components/message-thread.tsx", "e2e/tests/set-priority.spec.ts"]`
- E2E は `@feature-set-priority`。@smoke は1本のみ

## 備考

- VRT: 詳細パネルの見た目が変わる(優先度行がセレクトに)ため baseline
  再生成はメインが統合フェーズで行う。visual.spec.ts に触れない
- aria snapshot を書く場合は CI=1 で照合(ローカルは aria もスキップされる)
