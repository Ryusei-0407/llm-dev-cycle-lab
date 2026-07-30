# Feature: authz

チケット API のロール別認可。M2 で「M3 で実施」とした項目。

## 認可ルール(oRPC tickets.* + draft)

すべて**セッション必須**(context.user null → ORPCError("UNAUTHORIZED"))。その上で:

| 手続き                      | agent          | customer                                                                                                           |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| tickets.list                | 全件           | **自分のチケットのみ**(requesterEmail = user.email)                                                                |
| tickets.get / tickets.reply | 任意のチケット | 自分のチケットのみ(他人のは **ORPCError("FORBIDDEN")**。不在は従来どおり NOT_FOUND — 判定順は 存在確認 → 所有確認) |
| tickets.setStatus           | 可             | **不可(FORBIDDEN)**                                                                                                |
| tickets.create              | 可             | 可                                                                                                                 |
| POST /api/tickets/draft     | 可             | **不可(HTTP 403 {error:"forbidden"})**(エージェント用ツールのため)                                                 |

- 実装は router 層(+ draft route)で行い、store 契約は無変更(list のフィルタは store.list に
  optional filter を足してよい: `list(filter?: { requesterEmail?: string })` — 既存呼び出しは無引数のまま)
- db_misconfigured ガードは**認可より先**に評価(既存の固定テストを壊さない)

## 既存テストへの影響(裁定済みのテスト更新 — この2箇所のみ許可)

1. apps/api/test/session-requester.test.ts の「cookie 無しの list は成功」→ 仕様変更により
   「cookie 無しの list は 401 UNAUTHORIZED」に書き換える
2. なし(他の既存テストは agent セッションで走るため無変更グリーンのはず)

## unit観点(HTTP面)

- 未認証 list/get/reply/setStatus → 401
- customer list → 自分のチケットのみ(agent 作成チケットを1件作ってから customer で list し、混入しないこと)
- customer が他人の get / reply → FORBIDDEN(403)/ 不在 id は NOT_FOUND(404)のまま
- customer setStatus → FORBIDDEN / agent setStatus → 従来どおり成功
- customer draft → 403 forbidden / agent draft → 従来どおり(mock SSE)

## E2E観点

新規E2Eなし(顧客側のE2Eは customer-portal 仕様が担当)。既存E2E(agent セッション)は無変更グリーン。
