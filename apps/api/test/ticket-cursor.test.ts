import { describe, expect, it } from "vitest";
// ticket-model introduces a keyset-pagination cursor codec (spec:
// specs/ticket-model.md listPage). The cursor is an opaque token
// base64url("${createdAt ISO}|${id}"). The module does not exist yet in this
// branch (RED). Assumed public shape (spec 由来): encodeCursor({ createdAt, id })
// → string, decodeCursor(token) → { createdAt, id }, throwing on malformed input.
import { decodeCursor, encodeCursor } from "../src/tickets/cursor.js";

const CREATED_AT = "2026-01-03T00:00:00.000Z";
const ID = "00000000-0000-7000-8000-000000000003";

describe("ticket cursor codec @feature-ticket-model", () => {
  it(
    "encode → decode の往復で createdAt/id を復元する",
    {
      annotation: {
        type: "description",
        description:
          "encodeCursor で作ったトークンを decodeCursor に通すと、元の { createdAt, id } が復元されることを検証(往復)",
      },
    },
    () => {
      const token = encodeCursor({ createdAt: CREATED_AT, id: ID });
      expect(decodeCursor(token)).toEqual({ createdAt: CREATED_AT, id: ID });
    },
  );

  it(
    "トークンは base64url(createdAt|id)である",
    {
      annotation: {
        type: "description",
        description:
          "encodeCursor が仕様どおり base64url(`${createdAt ISO}|${id}`) を返すことを検証(不透明トークンの中身を固定)",
      },
    },
    () => {
      const token = encodeCursor({ createdAt: CREATED_AT, id: ID });
      const decoded = Buffer.from(token, "base64url").toString("utf8");
      expect(decoded).toBe(`${CREATED_AT}|${ID}`);
    },
  );

  it(
    "デコード不能なトークンで throw する",
    {
      annotation: {
        type: "description",
        description:
          "base64url としてデコードしても区切りが無い等で形式不正なトークンを decodeCursor が throw することを検証",
      },
    },
    () => {
      // Valid base64url but no "|" separator once decoded.
      const bad = Buffer.from("no-separator-here", "utf8").toString("base64url");
      expect(() => decodeCursor(bad)).toThrow();
    },
  );

  it(
    "空文字列トークンで throw する",
    {
      annotation: {
        type: "description",
        description: "空文字列を decodeCursor に渡すと throw することを検証(不正カーソルの下限)",
      },
    },
    () => {
      expect(() => decodeCursor("")).toThrow();
    },
  );
});
