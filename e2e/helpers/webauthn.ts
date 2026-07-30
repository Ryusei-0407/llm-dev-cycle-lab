import type { BrowserContext } from "@playwright/test";

// WebAuthn virtual authenticator seam (spec: specs/passkey.md E2E観点). Playwright
// 1.62 の browserContext.credentials は仮想オーセンティケータを提供する: install()
// 以降、この context の navigator.credentials.create()/get() には仮想デバイスが
// 自動応答し、実オーセンティケータ(OS のパスキー UI)は無効化される。API 形状は
// ここに隔離する — Playwright 側の型が変わってもテスト本体を触らずに済むように。
//
// これらは context.credentials.* の薄いラッパーで、E2E は「登録された鍵の集合を
// 観測・操作する」意図語彙(installAuthenticator / listCredentials / clear)で書く。

// この context に仮想オーセンティケータを取り付け、以後 navigator.credentials の
// create()/get() を自動応答させる。describe の前処理で1回呼ぶ。rpId は Web オリジンの
// ホスト名(dev/E2E は localhost)。
export async function installAuthenticator(context: BrowserContext): Promise<void> {
  await context.credentials.install();
}

// 現在この context に登録されている credential を列挙する(ページが
// navigator.credentials.create で作ったものも含む)。id は base64url。
export async function listCredentials(context: BrowserContext) {
  return context.credentials.get();
}

// id を指定して credential を1件削除する。「鍵が消えた」失敗面(サーバーは知って
// いるがオーセンティケータ側に鍵が無い、あるいはその逆)を作るのに使う。
export async function deleteCredential(context: BrowserContext, id: string): Promise<void> {
  await context.credentials.delete(id);
}

// この context の全 credential を削除する。未登録状態からのパスキーログイン失敗
// (失敗1)を確実にするための前処理などに使う。
export async function clearCredentials(context: BrowserContext): Promise<void> {
  for (const cred of await context.credentials.get()) {
    await context.credentials.delete(cred.id);
  }
}
