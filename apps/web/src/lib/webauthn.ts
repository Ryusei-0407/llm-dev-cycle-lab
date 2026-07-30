// Thin WebAuthn client helpers (spec: specs/passkey.md — クライアントは
// navigator.credentials 直 + base64url 変換の薄いヘルパー、ライブラリ不要).
// The server speaks @simplewebauthn's JSON shape: challenge, user.id and
// credential ids arrive as base64url strings and must become ArrayBuffers for
// navigator.credentials; the browser's response comes back as ArrayBuffers and
// must return as base64url strings. These four converters are the whole seam.

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// navigator.credentials is absent in non-secure/unsupported contexts. The UI
// hides the passkey controls when this is false (spec: 非対応環境ではボタンを
// 出さない).
export function supportsPasskeys(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

// Registration options from the server (@simplewebauthn JSON) → the ArrayBuffer
// shape navigator.credentials.create expects. Only the fields the flow needs are
// converted; the rest pass through.
function toCreationOptions(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const user = options.user as { id: string; name: string; displayName: string };
  const exclude = (options.excludeCredentials as { id: string; type: string }[] | undefined) ?? [];
  return {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64urlToBytes(options.challenge as string),
    user: { ...user, id: base64urlToBytes(user.id) },
    excludeCredentials: exclude.map((c) => ({
      ...c,
      id: base64urlToBytes(c.id),
      type: "public-key" as const,
    })),
  };
}

function toRequestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const allow = (options.allowCredentials as { id: string; type: string }[] | undefined) ?? [];
  return {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64urlToBytes(options.challenge as string),
    allowCredentials: allow.map((c) => ({
      ...c,
      id: base64urlToBytes(c.id),
      type: "public-key" as const,
    })),
  };
}

// Serialize a navigator.credentials result back to the base64url JSON that
// @simplewebauthn/server verifies. Mirrors the library's RegistrationResponseJSON
// / AuthenticationResponseJSON without pulling in @simplewebauthn/browser.
function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const base: Record<string, unknown> = {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
  if (response instanceof AuthenticatorAttestationResponse) {
    base.response = {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    };
  } else {
    const asr = response as AuthenticatorAssertionResponse;
    base.response = {
      clientDataJSON: bytesToBase64url(asr.clientDataJSON),
      authenticatorData: bytesToBase64url(asr.authenticatorData),
      signature: bytesToBase64url(asr.signature),
      userHandle: asr.userHandle ? bytesToBase64url(asr.userHandle) : undefined,
    };
  }
  return base;
}

// Full registration ceremony: fetch options, run navigator.credentials.create,
// serialize the attestation. Returns the body the /register route expects
// ({response, challenge}) — the caller POSTs it. Throws on cancel/no-credential.
export async function createPasskeyCredential(
  options: Record<string, unknown>,
): Promise<{ response: Record<string, unknown>; challenge: string }> {
  const credential = (await navigator.credentials.create({
    publicKey: toCreationOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey_creation_cancelled");
  return { response: serializeCredential(credential), challenge: options.challenge as string };
}

// Full authentication ceremony: run navigator.credentials.get and serialize the
// assertion. Returns the {response} the /login route expects; the caller adds
// the challengeId it already holds. Throws on cancel/no-credential.
export async function getPasskeyAssertion(
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const credential = (await navigator.credentials.get({
    publicKey: toRequestOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey_assertion_cancelled");
  return serializeCredential(credential);
}
