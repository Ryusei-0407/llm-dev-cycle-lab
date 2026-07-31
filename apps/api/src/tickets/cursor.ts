import { BadRequestError } from "./store.js";

// Keyset-pagination cursor codec (spec: specs/ticket-model.md listPage). The
// cursor is an opaque token base64url("${createdAt ISO}|${id}"): the position of
// the last row on a page under the list ordering (created_at, id). Kept in its
// own module so the wire token stays a single, testable concern; store.ts
// re-exports these for its own listPage use.

export type CursorPosition = { createdAt: string; id: string };

// id は SQL 側で ::uuid キャストされる。形状検証を通しておかないと、偽造
// トークンの非 uuid id が pg のキャストエラー(=500)に化けて仕様の
// BAD_REQUEST "invalid cursor" を破る(敵対的レビューの反例)。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor({ createdAt, id }: CursorPosition): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("invalid cursor");
  }
  const sep = decoded.indexOf("|");
  if (sep < 0) throw new BadRequestError("invalid cursor");
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  // A valid token always carries a parseable ISO timestamp and a uuid id;
  // anything else is a forged/corrupt cursor.
  if (!UUID.test(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new BadRequestError("invalid cursor");
  }
  return { createdAt, id };
}
