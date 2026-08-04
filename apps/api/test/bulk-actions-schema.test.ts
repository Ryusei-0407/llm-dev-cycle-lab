import { describe, expect, it } from "vitest";
// bulk-actions adds bulkUpdateInput to the tickets schema module (spec:
// specs/bulk-actions.md 公開インターフェース). input: { ids: string[](uuid, min 1
// / max 50), patch: { status?, priority?, assigneeEmail?: string|null } } with a
// .refine that requires patch to carry at least one key. This export does not
// exist yet in this branch (RED). 命名は既存の setPriorityInput / setAssigneeInput
// の流儀に揃える。
import { bulkUpdateInput } from "../src/tickets/schema.js";

// UUID v7 の実シード id を使う(zod は uuid 形式のみを見るのでどの版でも良いが、
// 具体シードに揃えて可読性を上げる)。
const ID_1 = "00000000-0000-7000-8000-000000000001";
const ID_2 = "00000000-0000-7000-8000-000000000002";

describe("tickets bulkUpdate input schema @feature-bulk-actions", () => {
  it(
    "1件以上の uuid と patch の各キーの組み合わせを受理する",
    {
      annotation: {
        type: "description",
        description:
          "bulkUpdate の入力 { ids, patch } が、1件以上の uuid 配列 + status / priority / assigneeEmail(email 文字列)/ assigneeEmail=null(担当解除)の各 patch 形で受理されることを検証",
      },
    },
    () => {
      expect(bulkUpdateInput.parse({ ids: [ID_1], patch: { status: "in_progress" } })).toEqual({
        ids: [ID_1],
        patch: { status: "in_progress" },
      });
      expect(bulkUpdateInput.parse({ ids: [ID_1, ID_2], patch: { priority: "high" } })).toEqual({
        ids: [ID_1, ID_2],
        patch: { priority: "high" },
      });
      expect(
        bulkUpdateInput.parse({ ids: [ID_1], patch: { assigneeEmail: "agent@example.com" } }),
      ).toEqual({ ids: [ID_1], patch: { assigneeEmail: "agent@example.com" } });
      // assigneeEmail: null = 担当解除(setAssignee と同じく null 明示を受理)。
      expect(bulkUpdateInput.parse({ ids: [ID_1], patch: { assigneeEmail: null } })).toEqual({
        ids: [ID_1],
        patch: { assigneeEmail: null },
      });
    },
  );

  it(
    "ids が空配列の入力を拒否する(min 1)",
    {
      annotation: {
        type: "description",
        description:
          "ids が空配列(0件)の bulkUpdate 入力が min 1 の検証で拒否されることを検証(一括更新は最低1件を対象にする)",
      },
    },
    () => {
      expect(bulkUpdateInput.safeParse({ ids: [], patch: { status: "open" } }).success).toBe(false);
    },
  );

  it(
    "ids が51件の入力を拒否する(max 50)",
    {
      annotation: {
        type: "description",
        description:
          "ids が51件(上限50超過)の bulkUpdate 入力が max 50 の検証で拒否されることを検証(1リクエストの一括更新件数に上限を設ける)",
      },
    },
    () => {
      const fiftyOne = Array.from(
        { length: 51 },
        (_, i) => `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
      );
      expect(fiftyOne).toHaveLength(51);
      expect(bulkUpdateInput.safeParse({ ids: fiftyOne, patch: { status: "open" } }).success).toBe(
        false,
      );
    },
  );

  it(
    "境界の50件の入力を受理する(max 50)",
    {
      annotation: {
        type: "description",
        description:
          "ids がちょうど50件(上限)の bulkUpdate 入力が受理されることを検証(上限の境界値をアンカーする)",
      },
    },
    () => {
      const fifty = Array.from(
        { length: 50 },
        (_, i) => `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
      );
      expect(bulkUpdateInput.safeParse({ ids: fifty, patch: { status: "open" } }).success).toBe(
        true,
      );
    },
  );

  it(
    "patch が空オブジェクトの入力を拒否する(.refine: 最低1キー)",
    {
      annotation: {
        type: "description",
        description:
          "patch が空オブジェクト {}(変更キーが1つも無い)の bulkUpdate 入力が .refine で拒否されることを検証(何も変えない一括更新を弾く)",
      },
    },
    () => {
      expect(bulkUpdateInput.safeParse({ ids: [ID_1], patch: {} }).success).toBe(false);
    },
  );

  it(
    "ids に uuid でない要素が混じる入力を拒否する",
    {
      annotation: {
        type: "description",
        description:
          "ids のいずれかの要素が uuid 形式でない bulkUpdate 入力が要素の uuid 検証で拒否されることを検証",
      },
    },
    () => {
      expect(
        bulkUpdateInput.safeParse({ ids: [ID_1, "not-a-uuid"], patch: { status: "open" } }).success,
      ).toBe(false);
    },
  );

  it(
    "patch.status が enum 外の入力を拒否する",
    {
      annotation: {
        type: "description",
        description:
          "patch.status が open/in_progress/resolved 以外の bulkUpdate 入力が enum 検証で拒否されることを検証",
      },
    },
    () => {
      expect(
        bulkUpdateInput.safeParse({ ids: [ID_1], patch: { status: "archived" } }).success,
      ).toBe(false);
    },
  );

  it(
    "patch.priority が enum 外の入力を拒否する",
    {
      annotation: {
        type: "description",
        description:
          "patch.priority が low/medium/high 以外の bulkUpdate 入力が enum 検証で拒否されることを検証",
      },
    },
    () => {
      expect(
        bulkUpdateInput.safeParse({ ids: [ID_1], patch: { priority: "urgent" } }).success,
      ).toBe(false);
    },
  );
});
