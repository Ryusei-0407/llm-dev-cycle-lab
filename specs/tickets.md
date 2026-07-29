# Feature: tickets

チケットの一覧・作成・ステータス変更。tRPC v11 をここで導入する。

## Model

```ts
type Ticket = {
  id: string; // crypto.randomUUID()
  subject: string; // 1..200文字、必須
  status: "open" | "in_progress" | "resolved";
  priority: "low" | "medium" | "high";
  requesterEmail: string;
  createdAt: string; // ISO
};
```

## サーバー(Hono + @hono/trpc-server、/api/trpc にマウント)

- `tickets.list` → `Ticket[]`(createdAt 降順)
- `tickets.create` input `{subject, priority}` → `Ticket`(subject 空/200超は zod でエラー)
- `tickets.setStatus` input `{id, status}` → `Ticket` / 見つからなければ NOT_FOUND
- in-memory store + シード3件(決定的):
  1. "Cannot login to dashboard" / open / high / customer@example.com
  2. "Billing question" / in_progress / medium / customer@example.com
  3. "Feature request: dark mode" / resolved / low / customer@example.com

## UI(/tickets ルート)

- 一覧: `data-testid="ticket-list"`、各行 `data-testid="ticket-row"`(subject、status-badge、priority)。APP_DESIGN.md の status-badge / feature-card 準拠
- 作成: `button "New ticket"` → フォーム(`aria-label="Subject"`、priority の select)→ `button "Create"`。成功で一覧先頭に追加。バリデーション失敗 `data-testid="ticket-error"`
- ステータス変更: 行内の操作(select 可)で変更、UI 即時反映
- クライアント: `@trpc/tanstack-react-query` + TanStack Query(router loader での ensureQueryData は任意)
- 認証: **このブランチでは認証ガードを付けない**(auth と並列開発のため。統合フェーズで付与)

## E2E観点(@feature-tickets)

- 正常(@smoke): /tickets → シード3件表示 → New ticket → subject入力+Create → 一覧先頭に表示。最終状態に aria snapshot
- 失敗1: 空 subject で Create → ticket-error 表示、一覧は3件のまま
- 失敗2: `page.route` で tRPC list を 500 に → `data-testid="tickets-load-error"` 表示

## component観点(Vitest Browser Mode)

- ステータス変更の即時反映(操作→badge が切り替わる描画を実ブラウザで検証)

## unit観点

- tickets store(create のバリデーション・並び順・setStatus・NOT_FOUND)
- zod input スキーマ
