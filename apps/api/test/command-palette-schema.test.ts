import { describe, expect, it } from "vitest";
// command-palette adds the tickets.search input schema (spec: specs/command-palette.md
// サーバー). input: { q: string }, zod: trim 後 1..100 文字。The searchInput export
// does not exist yet in this branch (RED). Follows the createInput / listPageInput
// naming already used in ../src/tickets/schema.js。
import { searchInput } from "../src/tickets/schema.js";

describe("command-palette tickets.search input schema @feature-command-palette", () => {
  it(
    "q をトリムして受理する(前後空白は落ちる)",
    {
      annotation: {
        type: "description",
        description:
          "searchInput が前後に空白を含む q を受理し、パース結果の q がトリム済み(前後空白なし)であることを検証(zod: trim)",
      },
    },
    () => {
      const parsed = searchInput.safeParse({ q: "  billing  " });
      expect(parsed.success).toBe(true);
      // trim が実際に適用されていること(単なる string 受理では通らない)。
      expect(parsed.success && parsed.data.q).toBe("billing");
    },
  );

  it(
    "空文字を拒否する",
    {
      annotation: {
        type: "description",
        description: "searchInput が空文字の q を入力検証で拒否することを検証(最小1文字)",
      },
    },
    () => {
      expect(searchInput.safeParse({ q: "" }).success).toBe(false);
    },
  );

  it(
    "空白のみは trim 後に空になり拒否する",
    {
      annotation: {
        type: "description",
        description:
          "searchInput が空白のみの q を、trim 後に空文字となるため拒否することを検証(trim → 最小1文字の順序)",
      },
    },
    () => {
      expect(searchInput.safeParse({ q: "   " }).success).toBe(false);
    },
  );

  it(
    "境界の1文字を受理する",
    {
      annotation: {
        type: "description",
        description: "searchInput が trim 後ちょうど1文字の q を受理することを検証(下限境界)",
      },
    },
    () => {
      expect(searchInput.safeParse({ q: "a" }).success).toBe(true);
    },
  );

  it(
    "境界の100文字を受理する",
    {
      annotation: {
        type: "description",
        description: "searchInput が trim 後ちょうど100文字の q を受理することを検証(上限境界)",
      },
    },
    () => {
      expect(searchInput.safeParse({ q: "a".repeat(100) }).success).toBe(true);
    },
  );

  it(
    "101文字を拒否する",
    {
      annotation: {
        type: "description",
        description: "searchInput が trim 後101文字の q を入力検証で拒否することを検証(上限超過)",
      },
    },
    () => {
      expect(searchInput.safeParse({ q: "a".repeat(101) }).success).toBe(false);
    },
  );

  it(
    "q 欠落を拒否する",
    {
      annotation: {
        type: "description",
        description: "searchInput が q フィールドの無い入力を拒否することを検証(q は必須)",
      },
    },
    () => {
      expect(searchInput.safeParse({}).success).toBe(false);
    },
  );
});
