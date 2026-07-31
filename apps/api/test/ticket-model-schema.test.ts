import { describe, expect, it } from "vitest";
// ticket-model adds setAssigneeInput / setLabelsInput / listPageInput to the
// tickets schema module (spec: specs/ticket-model.md サーバー). These exports do
// not exist yet in this branch (RED).
import { listPageInput, setAssigneeInput, setLabelsInput } from "../src/tickets/schema.js";

const VALID_ID = "00000000-0000-7000-8000-000000000001";

describe("tickets setAssignee input schema @feature-ticket-model", () => {
  it(
    "accepts an id + agent email",
    {
      annotation: {
        type: "description",
        description:
          "setAssignee の入力 { id, assigneeEmail } が有効な uuid + メールで受理されることを検証",
      },
    },
    () => {
      expect(setAssigneeInput.parse({ id: VALID_ID, assigneeEmail: "agent@example.com" })).toEqual({
        id: VALID_ID,
        assigneeEmail: "agent@example.com",
      });
    },
  );

  it(
    "accepts null assigneeEmail (未割り当てへ戻す)",
    {
      annotation: {
        type: "description",
        description:
          "assigneeEmail に null(未割り当てへ戻す)を渡した setAssignee 入力が受理されることを検証",
      },
    },
    () => {
      expect(setAssigneeInput.parse({ id: VALID_ID, assigneeEmail: null })).toEqual({
        id: VALID_ID,
        assigneeEmail: null,
      });
    },
  );

  it(
    "rejects a non-uuid id",
    {
      annotation: {
        type: "description",
        description: "setAssignee の id が uuid でない場合に入力検証で拒否されることを検証",
      },
    },
    () => {
      expect(
        setAssigneeInput.safeParse({ id: "not-a-uuid", assigneeEmail: "agent@example.com" })
          .success,
      ).toBe(false);
    },
  );

  it(
    "rejects a missing assigneeEmail key (null と undefined は別)",
    {
      annotation: {
        type: "description",
        description:
          "assigneeEmail キーそのものが欠落した setAssignee 入力が拒否されることを検証(null 明示と undefined 省略を区別する)",
      },
    },
    () => {
      expect(setAssigneeInput.safeParse({ id: VALID_ID }).success).toBe(false);
    },
  );
});

describe("tickets setLabels input schema @feature-ticket-model", () => {
  it(
    "accepts an id + label name array",
    {
      annotation: {
        type: "description",
        description: "setLabels の入力 { id, labels: string[] } が受理されることを検証",
      },
    },
    () => {
      expect(setLabelsInput.parse({ id: VALID_ID, labels: ["auth", "billing"] })).toEqual({
        id: VALID_ID,
        labels: ["auth", "billing"],
      });
    },
  );

  it(
    "accepts an empty labels array (全解除)",
    {
      annotation: {
        type: "description",
        description: "labels に空配列(全ラベル解除)を渡した setLabels 入力が受理されることを検証",
      },
    },
    () => {
      expect(setLabelsInput.parse({ id: VALID_ID, labels: [] })).toEqual({
        id: VALID_ID,
        labels: [],
      });
    },
  );

  it(
    "rejects non-string labels entries",
    {
      annotation: {
        type: "description",
        description: "labels 配列に文字列以外が混ざった setLabels 入力が拒否されることを検証",
      },
    },
    () => {
      expect(setLabelsInput.safeParse({ id: VALID_ID, labels: ["auth", 3] }).success).toBe(false);
    },
  );

  it(
    "rejects a non-uuid id",
    {
      annotation: {
        type: "description",
        description: "setLabels の id が uuid でない場合に入力検証で拒否されることを検証",
      },
    },
    () => {
      expect(setLabelsInput.safeParse({ id: "nope", labels: ["auth"] }).success).toBe(false);
    },
  );
});

describe("tickets listPage input schema @feature-ticket-model", () => {
  it(
    "accepts an empty input (cursor/limit ともに省略可)",
    {
      annotation: {
        type: "description",
        description:
          "listPage が cursor も limit も無い空入力を受理することを検証(先頭ページを既定 limit で取得できる)",
      },
    },
    () => {
      expect(listPageInput.safeParse({}).success).toBe(true);
    },
  );

  it(
    "accepts the boundary limits 1 and 100",
    {
      annotation: {
        type: "description",
        description: "listPage の limit が下限1・上限100の境界値を受理することを検証",
      },
    },
    () => {
      expect(listPageInput.safeParse({ limit: 1 }).success).toBe(true);
      expect(listPageInput.safeParse({ limit: 100 }).success).toBe(true);
    },
  );

  it(
    "rejects limit below 1 and above 100",
    {
      annotation: {
        type: "description",
        description:
          "listPage の limit が 0 や 101 など 1..100 の範囲外だと入力検証で拒否されることを検証",
      },
    },
    () => {
      expect(listPageInput.safeParse({ limit: 0 }).success).toBe(false);
      expect(listPageInput.safeParse({ limit: 101 }).success).toBe(false);
    },
  );

  it(
    "rejects a non-integer limit",
    {
      annotation: {
        type: "description",
        description: "listPage の limit が小数など整数でない値だと拒否されることを検証(int 制約)",
      },
    },
    () => {
      expect(listPageInput.safeParse({ limit: 1.5 }).success).toBe(false);
    },
  );

  it(
    "accepts a string cursor (中身の検証は codec/手続き側)",
    {
      annotation: {
        type: "description",
        description:
          "listPage の cursor が文字列であればスキーマ層は受理し、トークンの妥当性検査は codec/手続き側に委ねることを検証",
      },
    },
    () => {
      expect(listPageInput.safeParse({ cursor: "abc" }).success).toBe(true);
    },
  );
});
