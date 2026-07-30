# Feature: passkey

WebAuthn パスキーによるログイン。登録(サインイン済みユーザーが自分のパスキーを追加)と、
ログイン画面からのユーザー名レス・パスキーサインイン。
**Playwright v1.61 の仮想オーセンティケータ(browserContext.credentials)の検証対象**。

## 方針

- サーバー検証は **@simplewebauthn/server(バージョン固定)** を使う(WebAuthn の
  attestation/assertion 検証は手書きしない — セキュリティ実装の定石)。
  クライアントは navigator.credentials 直 + base64url 変換の薄いヘルパー(ライブラリ不要)
- rpId は Web オリジンのホスト名(dev/E2E では localhost)。オリジンは Origin ヘッダで検証

## DB(schema.sql / seed.sql)

```sql
CREATE TABLE passkeys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE, -- base64url
  public_key text NOT NULL,           -- base64url (COSE)
  counter bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

シードなし(パスキーはテスト内で登録フローから作る)。

## サーバー契約(apps/api/src/auth/passkey.ts、/api/auth/passkey/*)

- `POST /register/options`(**セッション必須**、401)→ @simplewebauthn の
  generateRegistrationOptions。challenge はサーバー側の短期ストア(in-memory、TTL 2分、
  **単回使用**)に sid キーで保存
- `POST /register` body = クライアントの attestation → verifyRegistrationResponse。
  成功で passkeys 行を作成し 201 `{ok:true}`。challenge 不一致/再利用は 400
- `POST /login/options`(セッション不要)→ generateAuthenticationOptions
  (allowCredentials 空 = discoverable/ユーザー名レス)。challenge は返却する
  challengeId(uuid)キーで短期ストアへ
- `POST /login` body = assertion + challengeId → verifyAuthenticationResponse。
  credential_id から user を引き、成功で**既存ログインと同一のセッション cookie を発行**
  (sid、httpOnly/lax — 挙動は password ログインと完全同型)。失敗/未知 credential は
  401 `{error:"invalid_passkey"}`。counter を更新
- **検証器は注入可能に**(unit はスタブ検証器で配線を検証、実物は @simplewebauthn)

## UI

- /login に `button "パスキーでログイン"`(data-testid="passkey-login")。
  成功で password ログインと同じ遷移(/ へ)。失敗は既存 login-error に表示
- TopNav(サインイン済み)に `button "パスキーを登録"`(data-testid="passkey-register")。
  成功で data-testid="passkey-registered" のフィードバック表示、失敗 data-testid="passkey-error"
- WebAuthn 非対応環境(navigator.credentials 不在)ではボタンを出さない

## unit観点(apps/api/test/passkey.test.ts — スタブ検証器で配線を検証)

- register/options: 未認証 401 / 認証済みで challenge が発行される
- register: challenge 不一致 400 / **同一 challenge の再利用 400(単回使用)** / 成功で
  passkeys 行が永続(同一 credential_id の二重登録は 409 か 400)
- login: 未知 credential_id 401 / 成功で Set-Cookie sid が発行され /api/auth/me が 200 /
  counter が更新される
- 検証器スタブは「challenge/オリジン一致なら成功」を模す(実暗号は E2E の仮想オーセンティケータが担う)

## E2E観点(@feature-passkey、実 @simplewebauthn + 仮想オーセンティケータ)

前提: `context.credentials.create("localhost")` + `install()` を describe の前処理で
(ヘルパー e2e/helpers/webauthn.ts に隔離 — API 形状の seam)。

- 正常(@smoke): **全周** — password でログイン → パスキーを登録(仮想オーセンティケータが
  navigator.credentials.create に自動応答)→ passkey-registered 表示 → Sign out →
  /login で「パスキーでログイン」→ ユーザー名レスでログイン成立(current-user 表示)。
  最終状態に aria snapshot
- 失敗1: 未登録状態(登録フローを踏まずに)でパスキーログイン → login-error 表示、/login に留まる
- 失敗2: `context.credentials.delete()` で鍵を消してから(または別の未知鍵で)ログイン →
  login-error(サーバー 401 経路)
  ※ 失敗1と実質同経路になる場合は、失敗2は「登録後にサーバー側 DB から鍵が消えた」状況を
  API で作る等、**別の失敗面**を選んでよい(判断を報告)

## MUST表の注意

「E2E 委譲」と書く項目には**委譲先のテスト名を明記**すること(M4 の委譲落とし穴の対策)。
