import { beforeEach, describe, expect, it } from "vitest";
import { createTicketStore } from "../src/tickets/store.js";

type StoreTicket = { id: string; subject: string; status: string; createdAt: string };

describe("ticket store", () => {
  let store: ReturnType<typeof createTicketStore>;

  beforeEach(() => {
    store = createTicketStore();
  });

  it("seeds three deterministic tickets in createdAt-descending order", () => {
    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list.map((t: StoreTicket) => t.subject)).toEqual([
      "Feature request: dark mode",
      "Billing question",
      "Cannot login to dashboard",
    ]);
    for (let i = 1; i < list.length; i++) {
      expect((list[i - 1] as StoreTicket).createdAt >= (list[i] as StoreTicket).createdAt).toBe(
        true,
      );
    }
  });

  it("seeds the documented status/priority/requester for each ticket", () => {
    const bySubject = new Map(store.list().map((t: StoreTicket) => [t.subject, t]));
    expect(bySubject.get("Cannot login to dashboard")).toMatchObject({
      status: "open",
      priority: "high",
      requesterEmail: "customer@example.com",
    });
    expect(bySubject.get("Billing question")).toMatchObject({
      status: "in_progress",
      priority: "medium",
      requesterEmail: "customer@example.com",
    });
    expect(bySubject.get("Feature request: dark mode")).toMatchObject({
      status: "resolved",
      priority: "low",
      requesterEmail: "customer@example.com",
    });
  });

  it("creates a ticket at the head of the list with a fresh id and open status", () => {
    const created = store.create({ subject: "New printer jam", priority: "medium" });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.status).toBe("open");
    expect(created.priority).toBe("medium");
    expect(created.subject).toBe("New printer jam");
    expect(typeof created.createdAt).toBe("string");

    const list = store.list();
    expect(list).toHaveLength(4);
    expect(list[0].id).toBe(created.id);
  });

  it("assigns a distinct id to each created ticket", () => {
    const a = store.create({ subject: "First", priority: "low" });
    const b = store.create({ subject: "Second", priority: "low" });
    expect(a.id).not.toBe(b.id);
  });

  it("rejects an empty subject", () => {
    expect(() => store.create({ subject: "", priority: "low" })).toThrow();
    expect(store.list()).toHaveLength(3);
  });

  it("rejects a subject longer than 200 characters", () => {
    expect(() => store.create({ subject: "x".repeat(201), priority: "low" })).toThrow();
    expect(store.list()).toHaveLength(3);
  });

  it("accepts a 200-character subject at the boundary", () => {
    const created = store.create({ subject: "x".repeat(200), priority: "high" });
    expect(created.subject).toHaveLength(200);
  });

  it("setStatus updates the status of an existing ticket and returns it", () => {
    const target = store.list()[0];
    const updated = store.setStatus({ id: target.id, status: "resolved" });
    expect(updated.id).toBe(target.id);
    expect(updated.status).toBe("resolved");
    expect(store.list().find((t: StoreTicket) => t.id === target.id)?.status).toBe("resolved");
  });

  it("setStatus throws NOT_FOUND for an unknown id", () => {
    expect(() => store.setStatus({ id: "does-not-exist", status: "open" })).toThrow(/NOT_FOUND/);
  });
});
