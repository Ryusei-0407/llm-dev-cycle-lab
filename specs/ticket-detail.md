# Feature: ticket-detail

チケット詳細ページ。会話スレッド(顧客とエージェントのメッセージ)の閲覧と返信投稿。
M2 の核であり、reply-draft(LLMドラフト)の土台。

## DB(apps/api/db/schema.sql に追加)

```sql
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_email text NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('customer', 'agent')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

シード(seed.sql に追加、固定 v7 id・固定時刻で決定的):

- ticket 1(Cannot login to dashboard): customer メッセージ "I can't sign in to the dashboard since this morning. It says invalid credentials."(id ...-000000000101、2026-01-01T01:00Z)+ agent メッセージ "Thanks for the report — could you tell me if you recently changed your password?"(id ...-000000000102、2026-01-01T02:00Z)
- ticket 2(Billing question): customer メッセージ "Our invoice for June seems to double-count seats."(id ...-000000000103、2026-01-02T01:00Z)

## サーバー契約

- `apps/api/src/tickets/messages.ts` → `createMessageStore(pool)`:
  - `listByTicket(ticketId): Promise<Message[]>`(created_at ASC, id ASC)
  - `create({ ticketId, authorEmail, authorRole, body }): Promise<Message>`(ticket 不在は store.ts の `NotFoundError` を throw)
  - `type Message = { id; ticketId; authorEmail; authorRole: "customer"|"agent"; body; createdAt }`
- schema.ts に追加: `getInput = z.object({ id: z.string().uuid() })`、`replyInput = z.object({ ticketId: z.string().uuid(), body: z.string().min(1).max(2000) })`
- oRPC router に追加:
  - `tickets.get`(getInput)→ `{ ticket: Ticket, messages: Message[] }`(不在は ORPCError("NOT_FOUND"))
  - `tickets.reply`(replyInput)→ `Message`。**author はセッション user 由来**(context.user。null なら ORPCError("UNAUTHORIZED"))。authorEmail = user.email、authorRole = user.role
- context.user の注入: app.ts の /api/rpc マウントで `createAuthRouter()` の `resolveUser(c)` を context に渡す前提
  (session-requester レーンと同一設計。自レーンで必要最小を実装してよい — 統合時に一本化)

## UI(apps/web)

- ticket-row の subject を `/tickets/$id` への Link に(data-testid="ticket-link")
- `src/routes/tickets.$id.tsx`(認証ガードは既存の仕組みに従う):
  - 見出し data-testid="ticket-subject" + status-badge
  - スレッド data-testid="message-thread"、各件 data-testid="message-item"
    (author 表示 data-testid="message-author": "Chika Customer" 等の名前でなく email でよい。role で左右寄せ等の Linear 風差別化)
  - 返信フォーム: textarea aria-label="Reply"、button "Send reply"。成功でスレッド末尾に即時反映・textarea クリア。失敗 data-testid="reply-error"
  - 不在 id: data-testid="ticket-not-found" の表示(アプリは落ちない)
- oRPC クライアント: `orpc.tickets.get.queryOptions({ input: { id } })` / `orpc.tickets.reply.mutationOptions(...)`、返信成功で get を invalidate

## E2E観点(@feature-ticket-detail)

- 正常(@smoke): /tickets → seed ticket("Cannot login to dashboard")の ticket-link を開く → ticket-subject とシードメッセージ2件表示 → Reply に入力して Send reply → スレッド末尾に自分の返信(author = agent)表示・textarea 空。最終状態に aria snapshot
- 失敗1: 存在しない id(00000000-0000-7000-8000-0000000000ff)へ直アクセス → ticket-not-found 表示
- 失敗2: 空のまま Send reply → reply-error 表示、**スレッド件数は前後比較で不変**(絶対数を使わない)

## unit/統合観点

- message store: listByTicket の昇順 / create の永続化と返り値 / ticket 不在 NotFoundError / body 境界(1/2000/2001)
- schema: getInput / replyInput のバリデーション
- CHECK 制約(author_role / body 長)は raw INSERT で1本(既存の CHECK テストの流儀)
