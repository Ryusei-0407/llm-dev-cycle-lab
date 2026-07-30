import { describe, expect, it } from "vitest";
// ticket-detail adds getInput/replyInput to the existing tickets schema module
// (spec: specs/ticket-detail.md サーバー契約). These exports do not exist yet in
// this branch (RED).
import { getInput, replyInput } from "../src/tickets/schema.js";

const VALID_ID = "00000000-0000-7000-8000-000000000001";

describe("tickets get input schema", () => {
  it("accepts a valid uuid id", () => {
    expect(getInput.parse({ id: VALID_ID })).toEqual({ id: VALID_ID });
  });

  it("rejects a non-uuid id", () => {
    expect(getInput.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a missing id", () => {
    expect(getInput.safeParse({}).success).toBe(false);
  });
});

describe("tickets reply input schema", () => {
  it("accepts a valid ticketId + body", () => {
    expect(replyInput.parse({ ticketId: VALID_ID, body: "Thanks, looking into it." })).toEqual({
      ticketId: VALID_ID,
      body: "Thanks, looking into it.",
    });
  });

  it("accepts the boundary body lengths (1 and 2000)", () => {
    expect(replyInput.safeParse({ ticketId: VALID_ID, body: "x" }).success).toBe(true);
    expect(replyInput.safeParse({ ticketId: VALID_ID, body: "x".repeat(2000) }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(replyInput.safeParse({ ticketId: VALID_ID, body: "" }).success).toBe(false);
  });

  it("rejects a body longer than 2000 characters", () => {
    expect(replyInput.safeParse({ ticketId: VALID_ID, body: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("rejects a non-uuid ticketId", () => {
    expect(replyInput.safeParse({ ticketId: "nope", body: "hi" }).success).toBe(false);
  });
});
