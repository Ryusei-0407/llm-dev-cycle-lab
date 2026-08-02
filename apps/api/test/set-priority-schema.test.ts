import { describe, expect, it } from "vitest";
// set-priority adds setPriorityInput to the tickets schema module (spec:
// specs/set-priority.md サーバー). input: { id: string, priority: "low"|"medium"
// |"high" }. This export does not exist yet in this branch (RED).
import { setPriorityInput } from "../src/tickets/schema.js";

const VALID_ID = "00000000-0000-7000-8000-000000000001";

describe("tickets setPriority input schema @feature-set-priority", () => {
  it(
    "accepts an id + each of the three priority levels",
    {
      annotation: {
        type: "description",
        description:
          "setPriority の入力 { id, priority } が有効な uuid と low/medium/high の各値で受理されることを検証",
      },
    },
    () => {
      for (const priority of ["low", "medium", "high"] as const) {
        expect(setPriorityInput.parse({ id: VALID_ID, priority })).toEqual({
          id: VALID_ID,
          priority,
        });
      }
    },
  );

  it(
    "rejects a priority outside the enum",
    {
      annotation: {
        type: "description",
        description:
          "priority が low/medium/high 以外(例 urgent)の setPriority 入力が enum 検証で拒否されることを検証",
      },
    },
    () => {
      expect(setPriorityInput.safeParse({ id: VALID_ID, priority: "urgent" }).success).toBe(false);
    },
  );

  it(
    "rejects a non-uuid id",
    {
      annotation: {
        type: "description",
        description: "setPriority の id が uuid でない場合に入力検証で拒否されることを検証",
      },
    },
    () => {
      expect(setPriorityInput.safeParse({ id: "not-a-uuid", priority: "high" }).success).toBe(false);
    },
  );

  it(
    "rejects a missing priority key",
    {
      annotation: {
        type: "description",
        description: "priority キーが欠落した setPriority 入力が拒否されることを検証",
      },
    },
    () => {
      expect(setPriorityInput.safeParse({ id: VALID_ID }).success).toBe(false);
    },
  );
});
