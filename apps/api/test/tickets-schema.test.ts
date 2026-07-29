import { describe, expect, it } from "vitest";
import { createInput, setStatusInput } from "../src/tickets/schema.js";

describe("tickets create input schema", () => {
  it("accepts a valid subject + priority", () => {
    expect(createInput.parse({ subject: "Printer down", priority: "high" })).toEqual({
      subject: "Printer down",
      priority: "high",
    });
  });

  it("rejects an empty subject", () => {
    expect(createInput.safeParse({ subject: "", priority: "low" }).success).toBe(false);
  });

  it("rejects a subject longer than 200 characters", () => {
    expect(createInput.safeParse({ subject: "x".repeat(201), priority: "low" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown priority", () => {
    expect(createInput.safeParse({ subject: "ok", priority: "urgent" }).success).toBe(false);
  });
});

describe("tickets setStatus input schema", () => {
  it("accepts a valid id + status", () => {
    const parsed = setStatusInput.parse({ id: "abc", status: "in_progress" });
    expect(parsed).toEqual({ id: "abc", status: "in_progress" });
  });

  it("rejects an unknown status", () => {
    expect(setStatusInput.safeParse({ id: "abc", status: "closed" }).success).toBe(false);
  });
});
