import { describe, expect, it } from "vitest";
// triage extends the listPage input schema (spec: specs/triage.md サーバー).
// New optional fields, all backward-compatible (既存フィールドは不変): status /
// priority enums, a free-string label, and unassigned / unresolved booleans.
// listPageInput already exists (ticket-model); these cases pin the additions.
// The extended schema does not exist yet in this branch (RED).
import { listPageInput } from "../src/tickets/schema.js";

describe("triage listPage input schema @feature-triage", () => {
  it(
    "accepts the new optional filter fields together",
    {
      annotation: {
        type: "description",
        description:
          "listPage が新フィルタ(status/priority/label/unassigned/unresolved)を同時指定した入力を受理することを検証(後方互換の追加フィールド)",
      },
    },
    () => {
      const parsed = listPageInput.safeParse({
        status: "open",
        priority: "high",
        label: "auth",
        unassigned: true,
        unresolved: true,
      });
      expect(parsed.success).toBe(true);
      // 受理だけでなく、パース結果が新フィールドを保持していることを見る
      // (zod が未知キーを黙って strip すると "accepts" は素通りしてしまう。
      // 値の保持まで見て初めて「フィールドがモデル化された」ことの RED になる)。
      expect(parsed.data).toMatchObject({
        status: "open",
        priority: "high",
        label: "auth",
        unassigned: true,
        unresolved: true,
      });
    },
  );

  it(
    "accepts and retains each status enum value",
    {
      annotation: {
        type: "description",
        description:
          "listPage の status が open/in_progress/resolved の3値をいずれも受理し、パース結果に status が保持されることを検証(未知キー strip では通らない)",
      },
    },
    () => {
      for (const status of ["open", "in_progress", "resolved"]) {
        const parsed = listPageInput.safeParse({ status });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toMatchObject({ status });
      }
    },
  );

  it(
    "rejects an unknown status enum",
    {
      annotation: {
        type: "description",
        description:
          "listPage の status に enum 外の値(closed)を渡すと入力検証で拒否されることを検証(不正 enum 拒否)",
      },
    },
    () => {
      expect(listPageInput.safeParse({ status: "closed" }).success).toBe(false);
    },
  );

  it(
    "accepts and retains each priority enum value",
    {
      annotation: {
        type: "description",
        description:
          "listPage の priority が low/medium/high の3値をいずれも受理し、パース結果に priority が保持されることを検証(未知キー strip では通らない)",
      },
    },
    () => {
      for (const priority of ["low", "medium", "high"]) {
        const parsed = listPageInput.safeParse({ priority });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toMatchObject({ priority });
      }
    },
  );

  it(
    "rejects an unknown priority enum",
    {
      annotation: {
        type: "description",
        description:
          "listPage の priority に enum 外の値(urgent)を渡すと入力検証で拒否されることを検証(不正 enum 拒否)",
      },
    },
    () => {
      expect(listPageInput.safeParse({ priority: "urgent" }).success).toBe(false);
    },
  );

  it(
    "rejects a non-boolean unassigned / unresolved",
    {
      annotation: {
        type: "description",
        description:
          "listPage の unassigned / unresolved に boolean 以外(文字列 'true')を渡すと入力検証で拒否されることを検証(boolean 制約)",
      },
    },
    () => {
      expect(listPageInput.safeParse({ unassigned: "true" }).success).toBe(false);
      expect(listPageInput.safeParse({ unresolved: "true" }).success).toBe(false);
    },
  );

  it(
    "still accepts the pre-existing empty input (後方互換)",
    {
      annotation: {
        type: "description",
        description:
          "新フィールド追加後も listPage が空入力を受理し続けることを検証(既存フィールドは不変・後方互換)",
      },
    },
    () => {
      expect(listPageInput.safeParse({}).success).toBe(true);
    },
  );
});
