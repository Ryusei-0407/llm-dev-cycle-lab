# Feature: auth

ログイン/ログアウトとロール別セッション。サポートデスクの入口。

## シードユーザー(in-memory、決定的)

| email                | password      | role     | name           |
| -------------------- | ------------- | -------- | -------------- |
| agent@example.com    | agent-pass    | agent    | Aki Agent      |
| customer@example.com | customer-pass | customer | Chika Customer |

## 公開インターフェース(API — Hono、cookieセッション)

- `POST /api/auth/login` body `{email, password}` → 200 `{user: {id, email, role, name}}` + `Set-Cookie: sid=...`(httpOnly, sameSite=lax) / 401 `{error: "invalid_credentials"}`
- `POST /api/auth/logout` → 204、cookie 破棄
- `GET /api/auth/me` → 200 `{user}` / 未認証 401 `{error: "unauthenticated"}`
- セッションは in-memory store(sid → userId)。sid は `crypto.randomUUID()`

## 公開インターフェース(UI)

- `/login` ルート: 入力 `aria-label="Email"` / `aria-label="Password"`、`button "Sign in"`。失敗時 `data-testid="login-error"`。Linear テーマ(button-primary、text-input、APP_DESIGN.md 準拠)
- 認証ガード: 未ログインで保護ルート(`/` を含む)へアクセス → `/login` へリダイレクト
- ヘッダ(top-nav): `data-testid="current-user"` にユーザー名表示、`button "Sign out"` でログアウト → `/login` へ

## E2E観点(@feature-auth、モックせず実APIで可 — 認証は自前実装で決定的)

- 正常(@smoke): /login → agent 資格情報 → Sign in → `/` に遷移、current-user に "Aki Agent"。最終状態に aria snapshot
- 失敗1: 誤パスワード → login-error 表示、/login に留まる
- 失敗2: 未ログインで `/` 直アクセス → /login へリダイレクト
- **e2e/helpers/auth.ts**: `apiLogin(request, role)` — APIログインして storageState を返すヘルパー。Playwright setup project(`e2e/setup/auth.setup.ts`)で `e2e/.auth/agent.json` / `customer.json` を生成する構成も追加する

## unit観点

- セッション store(create/verify/destroy)
- credentials 検証(正しい/誤り/未知ユーザー)
- 認証ミドルウェア(cookie 無し→401、有効→user 注入)

## 統合時の注意(このブランチでは行わない)

既存チャットE2E(@feature-chat)は認証ガード導入で要更新(storageState 利用)。この更新は統合フェーズでメインセッションが裁定・実施する。
