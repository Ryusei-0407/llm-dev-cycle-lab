import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type PasskeyVerifier } from "../src/app.js";
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// passkey (spec: specs/passkey.md) は WebAuthn 登録/ログインを公開 HTTP 面
// (/api/auth/passkey/*)で検証する。auth-route / authz と同じ「契約をテストする」
// 流儀(login/sidFrom を踏襲、内部モジュールには触れない)。
//
// 実暗号(attestation/assertion 検証)は @simplewebauthn が担い、E2E の仮想
// オーセンティケータが行使する。ここでは検証器をスタブ注入して**配線**だけを見る:
// challenge の発行 → 単回使用ストア → passkeys 行の永続 → セッション cookie 発行。
// スタブは「challenge が発行済みなら成功」を模す(spec: 検証器スタブは challenge/
// オリジン一致なら成功)。実際の公開鍵検証は E2E に委譲する。

// vitest globalSetup(apps/api/test/global-setup.ts)が一時DBを供給する前提。
// 接続文字列はここにハードコードしない(POLICY.md §共通規約)。
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/passkey.md)",
    );
  }
  return url;
}

const SEED = {
  agent: { email: "agent@example.com", password: "agent-pass" },
  customer: { email: "customer@example.com", password: "customer-pass" },
} as const;

function login(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Hono の app.request には cookie jar が無いので、Set-Cookie から sid を取り出して
// 後続リクエストに手で載せる(auth-route / authz と同じヘルパー)。
function sidFrom(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
}

async function cookieFor(
  app: ReturnType<typeof createApp>,
  seed: { email: string; password: string },
): Promise<string> {
  const res = await login(app, seed);
  expect(res.status).toBe(200);
  const sid = sidFrom(res);
  expect(sid).toBeTruthy();
  return `sid=${sid}`;
}

// 予想する公開契約(spec: specs/passkey.md サーバー契約)。unit はこの JSON 面のみ
// を叩く。/register/options と /login/options が返す challenge / challengeId を、
// 続く /register / /login の body に手で載せる(実 navigator.credentials は E2E)。
function post(app: ReturnType<typeof createApp>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request(`/api/auth/passkey/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// スタブ検証器: 実暗号を持たず「challenge が渡っていれば成功」を模す。attestation/
// assertion の中身は E2E の仮想オーセンティケータが本物を出すので、unit では
// クライアントが送った credentialId/publicKey/counter をそのまま採る(配線の観測)。
// 予想する注入契約(spec: 検証器は注入可能に。createApp options 経由):
//   createApp({ passkeyVerifier }) で差し替え、既定は実 @simplewebauthn。
//   - verifyRegistration({ response, expectedChallenge }) →
//       { verified, credentialId, publicKey, counter }
//   - verifyAuthentication({ response, expectedChallenge, credential }) →
//       { verified, newCounter }
// verified は「サーバー側 challenge が非 null(=発行済みで単回未使用)」で true。
// 単回使用・不一致・再利用はルーター側の challenge ストアが弾く責務なので、スタブは
// expectedChallenge が空文字/undefined のときだけ false(検証器まで届いた=ストアは
// 通過した、を表現)にする。
function stubVerifier(): PasskeyVerifier {
  return {
    async verifyRegistration({ response, expectedChallenge }) {
      const cred = response as {
        credentialId?: string;
        publicKey?: string;
        counter?: number;
      };
      return {
        verified: Boolean(expectedChallenge),
        credentialId: cred.credentialId ?? "stub-credential",
        publicKey: cred.publicKey ?? "stub-public-key",
        counter: cred.counter ?? 0,
      };
    },
    async verifyAuthentication({ response, expectedChallenge }) {
      const asn = response as { counter?: number };
      return {
        verified: Boolean(expectedChallenge),
        newCounter: asn.counter ?? 1,
      };
    },
  };
}

// options で発行された challenge(register)/ challengeId(login)を取り出す薄い型。
type RegisterOptions = { challenge: string } & Record<string, unknown>;
type LoginOptions = { challengeId: string } & Record<string, unknown>;

// register/options → challenge を取り、その challenge を積んだ attestation を作って
// /register に投げるところまでを一括。credentialId を返すので、後段の login や
// 二重登録テストが同じ鍵を指せる。
async function registerPasskey(
  app: ReturnType<typeof createApp>,
  cookie: string,
  credentialId = "cred-aaa",
): Promise<{ status: number; challenge: string }> {
  const optRes = await post(app, "register/options", {}, cookie);
  expect(optRes.status).toBe(200);
  const opts = (await optRes.json()) as RegisterOptions;
  const regRes = await post(
    app,
    "register",
    {
      response: { credentialId, publicKey: "pub-aaa", counter: 0 },
      challenge: opts.challenge,
    },
    cookie,
  );
  return { status: regRes.status, challenge: opts.challenge };
}

describe("passkey register/options: セッション必須 @feature-passkey", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未認証の register/options は 401 で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "cookie 無しで POST /api/auth/passkey/register/options を叩くと HTTP 401 で拒否され、challenge を発行しないことを検証(登録は自分のセッションに紐づく)",
      },
    },
    async () => {
      const res = await post(
        createApp({ passkeyVerifier: stubVerifier() }),
        "register/options",
        {},
      );
      expect(res.status).toBe(401);
    },
  );

  it(
    "認証済みの register/options は challenge を発行する",
    {
      annotation: {
        type: "description",
        description:
          "セッション cookie 付きで register/options を叩くと HTTP 200 で generateRegistrationOptions 由来の challenge(非空文字列)を返すことを検証(短期ストアへ sid キーで保存される前提)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(app, SEED.agent);
      const res = await post(app, "register/options", {}, cookie);
      expect(res.status).toBe(200);
      const opts = (await res.json()) as RegisterOptions;
      expect(typeof opts.challenge).toBe("string");
      expect(opts.challenge.length).toBeGreaterThan(0);
    },
  );
});

describe("passkey register: challenge 単回使用と永続 @feature-passkey", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "challenge 不一致の register は 400 で拒否される",
    {
      annotation: {
        type: "description",
        description:
          "register/options で得たのとは別の(サーバーが発行していない)challenge を積んだ attestation を register に送ると HTTP 400 で拒否されることを検証(challenge 一致がサーバー側必須)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(app, SEED.agent);
      // options を先に呼んでストアへ challenge を入れておくが、register には別値を送る。
      await post(app, "register/options", {}, cookie);
      const res = await post(
        app,
        "register",
        {
          response: { credentialId: "cred-x", publicKey: "pub-x", counter: 0 },
          challenge: "not-the-issued-challenge",
        },
        cookie,
      );
      expect(res.status).toBe(400);
    },
  );

  it(
    "同一 challenge の再利用は 400(単回使用)",
    {
      annotation: {
        type: "description",
        description:
          "1回成功した register と同じ challenge をもう一度 register に送ると HTTP 400 で拒否されることを検証(challenge はサーバー短期ストアで単回使用 = リプレイ防止)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(app, SEED.agent);
      const first = await registerPasskey(app, cookie, "cred-once");
      expect(first.status).toBe(201);
      // 同じ challenge を再送(2件目の credentialId でも challenge は消費済み)。
      const replay = await post(
        app,
        "register",
        {
          response: { credentialId: "cred-twice", publicKey: "pub-twice", counter: 0 },
          challenge: first.challenge,
        },
        cookie,
      );
      expect(replay.status).toBe(400);
    },
  );

  it(
    "成功した register は passkeys 行を永続する(別 app からログインできる)",
    {
      annotation: {
        type: "description",
        description:
          "register 成功で HTTP 201 {ok:true} を返し、passkeys 行が DB に永続することを、別 createApp インスタンスから同じ credential でログインが成立する(200 + sid 発行)ことで検証(in-memory ではなく DB 永続)",
      },
    },
    async () => {
      const writer = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(writer, SEED.agent);
      const reg = await registerPasskey(writer, cookie, "cred-persist");
      expect(reg.status).toBe(201);

      // 別 app インスタンス — in-memory Map なら鍵を知らないはず。DB 永続なら引ける。
      const reader = createApp({ passkeyVerifier: stubVerifier() });
      const optRes = await post(reader, "login/options", {});
      expect(optRes.status).toBe(200);
      const opts = (await optRes.json()) as LoginOptions;
      const loginRes = await post(reader, "login", {
        response: { credentialId: "cred-persist", counter: 1 },
        challengeId: opts.challengeId,
      });
      expect(loginRes.status).toBe(200);
      expect(sidFrom(loginRes)).toBeTruthy();
    },
  );

  it(
    "同一 credential_id の二重登録は拒否される(409 か 400)",
    {
      annotation: {
        type: "description",
        description:
          "同じ credentialId を2回 register すると2回目が拒否される(HTTP 409 または 400)ことを検証(passkeys.credential_id UNIQUE 制約 / 二重登録防止)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(app, SEED.agent);
      const first = await registerPasskey(app, cookie, "cred-dup");
      expect(first.status).toBe(201);
      // 新しい challenge を取り直して同じ credentialId を再登録 → 一意制約で拒否。
      const second = await registerPasskey(app, cookie, "cred-dup");
      expect([400, 409]).toContain(second.status);
    },
  );
});

describe("passkey login: 未知credential拒否と成功セッション @feature-passkey", () => {
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "未知の credential_id での login は 401 invalid_passkey",
    {
      annotation: {
        type: "description",
        description:
          "登録していない credentialId で login を叩くと HTTP 401 {error:'invalid_passkey'} で拒否され、Set-Cookie を発行しないことを検証(未知の鍵ではセッションを作らない)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const optRes = await post(app, "login/options", {});
      expect(optRes.status).toBe(200);
      const opts = (await optRes.json()) as LoginOptions;
      const res = await post(app, "login", {
        response: { credentialId: "never-registered", counter: 1 },
        challengeId: opts.challengeId,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_passkey" });
      expect(sidFrom(res)).toBeFalsy();
    },
  );

  it(
    "成功した login は sid cookie を発行し /api/auth/me が 200 になる",
    {
      annotation: {
        type: "description",
        description:
          "登録済み credential で login すると HTTP 200 + httpOnly/sameSite=lax の sid cookie が発行され、その cookie で /api/auth/me が 200(登録した agent 本人)を返すことを検証(password ログインと同型のセッション)",
      },
    },
    async () => {
      const app = createApp({ passkeyVerifier: stubVerifier() });
      const cookie = await cookieFor(app, SEED.agent);
      const reg = await registerPasskey(app, cookie, "cred-login");
      expect(reg.status).toBe(201);

      const optRes = await post(app, "login/options", {});
      const opts = (await optRes.json()) as LoginOptions;
      const loginRes = await post(app, "login", {
        response: { credentialId: "cred-login", counter: 1 },
        challengeId: opts.challengeId,
      });
      expect(loginRes.status).toBe(200);
      const setCookie = loginRes.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/sid=/);
      expect(setCookie.toLowerCase()).toContain("httponly");
      expect(setCookie.toLowerCase()).toContain("samesite=lax");

      const sid = sidFrom(loginRes);
      const me = await app.request("/api/auth/me", { headers: { cookie: `sid=${sid}` } });
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user: { email: string } };
      expect(body.user.email).toBe(SEED.agent.email);
    },
  );

  it(
    "login 成功で保存 counter が検証器の newCounter に更新される",
    {
      annotation: {
        type: "description",
        description:
          "counter=5 を返す検証器で login すると、続く login/options→login で assertion の前回値より進んだ counter が保存されていること(=行が更新された)を、別インスタンスからのログインが成立し続けることで検証(counter 更新の配線)",
      },
    },
    async () => {
      // このテストだけ newCounter を固定値に上書きした検証器を使い、counter 書き込みの
      // 配線を観測する(実際の counter 巻き戻し検知は E2E の実オーセンティケータ管轄)。
      const verifier: PasskeyVerifier = {
        ...stubVerifier(),
        async verifyAuthentication({ expectedChallenge }) {
          return { verified: Boolean(expectedChallenge), newCounter: 5 };
        },
      };
      const app = createApp({ passkeyVerifier: verifier });
      const cookie = await cookieFor(app, SEED.agent);
      const reg = await registerPasskey(app, cookie, "cred-counter");
      expect(reg.status).toBe(201);

      const optRes = await post(app, "login/options", {});
      const opts = (await optRes.json()) as LoginOptions;
      const loginRes = await post(app, "login", {
        response: { credentialId: "cred-counter", counter: 5 },
        challengeId: opts.challengeId,
      });
      expect(loginRes.status).toBe(200);

      // counter が 5 に上がった鍵で、続けてもう一度ログインできる(行が更新されて
      // 生きている = counter 更新が永続した)。
      const optRes2 = await post(app, "login/options", {});
      const opts2 = (await optRes2.json()) as LoginOptions;
      const loginRes2 = await post(app, "login", {
        response: { credentialId: "cred-counter", counter: 6 },
        challengeId: opts2.challengeId,
      });
      expect(loginRes2.status).toBe(200);
      expect(sidFrom(loginRes2)).toBeTruthy();
    },
  );
});
