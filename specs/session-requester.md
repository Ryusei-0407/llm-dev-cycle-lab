# Feature: session-requester

チケット作成者(requesterEmail)を、固定値ではなく**認証セッションのユーザー**から導出する。
(M1 裁定時に「将来仕様」とした項目の実施)

## サーバー契約

- `createAuthRouter()` の返り値に `resolveUser(c): User | null` を追加公開する
  (sid cookie → session → User。無効/無しは null。既存 requireAuth はこれを使う形にリファクタ可)
- app.ts の `/api/rpc` マウント: `handler.handle(c.req.raw, { prefix, context: { user: resolveUser(c) } })`
  で **oRPC context に user を注入**する。oRPC 側は `os.$context<{ user: User | null }>()`
- `tickets.create`: **セッション必須**。context.user が null なら `ORPCError("UNAUTHORIZED")`。
  requesterEmail は `context.user.email`。router 内の固定 "customer@example.com" 注入は削除
- `tickets.list` / `tickets.setStatus`: M2 では認可を付けない(context は受けるが未使用。M3 で実施)
- createInput(zod)/ store の契約 / HTTP パス / UI は**無変更**

## unit観点(HTTP面、実セッションで)

- agent でログイン(POST /api/auth/login)→ その cookie 付きで oRPC create → requesterEmail が agent@example.com
- customer ログイン → customer@example.com
- cookie 無しで create → oRPC の UNAUTHORIZED エラー(HTTP 401、oRPC エラー形式)
- cookie 無しで list → 従来どおり成功(M2 では create のみセッション必須)

## E2E観点

新規E2Eなし。既存 tickets E2E(agent セッションで走る)は無変更グリーンが受け入れ条件。

## 統合時の注意

ticket-detail レーンも context.user 注入を前提にしている。マウント側の注入実装が両レーンで
重複したら統合時に一本化する(実装は resolveUser 経由で同一のはず)。
