# Feature: orpc-migration

tickets の RPC 層を tRPC から **oRPC** に移行する(ユーザー指示の訂正)。
観測可能な UX・データ挙動は完全同一を維持する。

## パッケージ

- 削除: @trpc/server @hono/trpc-server @trpc/client @trpc/tanstack-react-query
- 追加: @orpc/server @orpc/client @orpc/tanstack-query(現行安定 1.13〜1.14 系、@latest で揃える)

## サーバー(apps/api)

- ルーター: `os` ビルダーで定義。`.query()/.mutation()` の区別は消え全て `.handler()`。
  ルーターは `t.router()` でなくプレーンオブジェクト `{ tickets: { list, create, setStatus } }`
- zod の input スキーマ(schema.ts)は**無変更で流用**
- NOT_FOUND: `throw new ORPCError("NOT_FOUND")`(@orpc/server)
- マウント: `RPCHandler`(@orpc/server/fetch)を Hono の `/api/rpc/*` に。
  `handler.handle(c.req.raw, { prefix: "/api/rpc", context: {...} })` → matched なら response 返却
- **db_misconfigured ガードは `/api/rpc/*` に移設**(挙動同一: DATABASE_URL 未設定 → 500)
- requesterEmail の router 側固定値注入(customer@example.com)は現状維持

## クライアント(apps/web)

- `apps/web/src/lib/trpc.ts` → `apps/web/src/lib/orpc.ts` に置換:
  `RPCLink({ url: <origin>/api/rpc })` → `createORPCClient` → `createTanstackQueryUtils`
- 呼び出し置換: `trpc.tickets.list.queryOptions()` → `orpc.tickets.list.queryOptions()`、
  mutation は `orpc.tickets.create.mutationOptions({...})`。
  invalidate は `orpc.tickets.list.queryKey()` 等(旧 API と同じ書き味)
- UI の data-testid・表示・挙動は一切変更しない

## ワイヤ形式(テストへの影響)

- oRPC の RPC プロトコル: POST、パスは `/api/rpc/tickets/list` のようなスラッシュ区切り
- **裁定済みテスト変更(この2箇所のみ許可。他のテスト変更は禁止)**:
  1. e2e/tests/tickets.spec.ts の load-error モック: glob `**/api/trpc/**` → `**/api/rpc/**`(メソッドは絞らない)
  2. apps/api/test/tickets-store.test.ts の db_misconfigured 固定テスト: リクエストを
     `POST /api/rpc/tickets/list`(JSON ボディ)に更新(ガードはハンドラ前に 500 を返すのでボディ形式は不問)
- 上記以外の全テスト(unit 46本相当 + E2E 15本)は**無変更でグリーン**が受け入れ条件

## その他

- e2e/feature-map.json: tickets に `apps/web/src/lib/orpc.ts` を追加(旧 trpc.ts が未登録だった穴も埋める)
- specs/tickets.md の「/api/trpc」「tRPC」記述を oRPC/`/api/rpc` に現行化(仕様は常に現在形)
- .gitignore に `.env` / `worklog.md` を正式追加(ローカル未コミット差分の摩擦解消)

## 検証観点

- 移行後に `curl -X POST /api/rpc/tickets/list`(JSON)でシード3件が返るワイヤ実測を1回行い報告
- 全レーン(check / unit / E2E コンテナDB)グリーン + コンテナ残存ゼロ
