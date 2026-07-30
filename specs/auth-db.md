# Feature: auth-db

ユーザーとセッションを in-memory から PostgreSQL に移行する(auth の DB 化)。
ログイン/ログアウト/ガードの**観測可能な挙動は完全同一**を維持。

## DB(schema.sql / seed.sql に追加)

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('agent', 'customer')),
  password_hash text NOT NULL, -- scrypt: "salt:hexhash"
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  sid uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- シード: 既存2ユーザー(agent/customer)を固定 v7 id(...-7000-8000-0000000000a1 / a2)で。
  password_hash は node:crypto の scryptSync(password, salt, 64)、salt は固定文字列
  (シードは決定的に。ハッシュ値は実装時に計算して seed.sql に埋める)
- sid は従来どおり crypto.randomUUID()(v4 で可 — セッションIDは秘匿トークンであり時系列不要)

## サーバー契約(公開面の維持)

- `apps/api/src/auth/users.ts`: `verifyCredentials(pool, email, password): Promise<User|null>` /
  `userById(pool, id): Promise<User|null>` に **async + pool 引数**化。User 型は現行と同じ形
  (id/email/role/name — password_hash は返さない)
- `apps/api/src/auth/session.ts`: `createDbSessionStore(pool)` → `{ create(userId): Promise<sid>, verify(sid): Promise<userId|null>, destroy(sid): Promise<void> }`
- `createAuthRouter(pool)` に pool を渡す。`resolveUser(c): Promise<User|null>` は async 化
  (app.ts の oRPC context 注入・draft route も await に追随)
- HTTP 挙動(login 200/401、logout 204 + cookie 破棄、me 200/401、cookie 属性)は**完全無変更**

## 既存テストへの影響(裁定済みのテスト更新 — この範囲のみ許可)

- apps/api/test/auth-route.test.ts のうち **session store を直接 import している unit**
  (create/verify/destroy 系)を async + pool 契約に書き換える(HTTP面のテストは無変更)
- それ以外の既存テスト(HTTP面・E2E)は無変更グリーンが受け入れ条件

## unit観点

- users: verifyCredentials(正/誤/未知)が DB シードに対して動く / userById
- session store: create→verify→destroy の永続化(別 store インスタンスでも verify できる = DB 由来の証明)
- ログアウト後の cookie 破棄・セッション失効(既存 HTTP テストが担保 — 無変更で緑のこと)

## E2E観点

新規E2Eなし。既存 auth E2E 3本 + setup project が無変更グリーン(セッションがDBでも storageState が機能する証明)。
