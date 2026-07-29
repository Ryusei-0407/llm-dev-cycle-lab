import { page } from "@vitest/browser/context";
import { useState } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { TicketList } from "@/components/ticket-list";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode): verifies that changing a
// ticket's status re-paints the status badge immediately in a real browser.
// The list is driven by local state so the test owns the data and needs no
// tRPC client or backend — it observes the render, not the network.

const seed: Ticket[] = [
  {
    id: "t1",
    subject: "Cannot login to dashboard",
    status: "open",
    priority: "high",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-03T00:00:00.000Z",
  },
];

function Harness() {
  const [tickets, setTickets] = useState<Ticket[]>(seed);
  return (
    <TicketList
      tickets={tickets}
      onStatusChange={(id: string, status: Ticket["status"]) =>
        setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
      }
    />
  );
}

test("repaints the status badge immediately when status changes", async () => {
  await render(<Harness />);

  const row = page.getByTestId("ticket-row");
  await expect.element(row.getByTestId("status-badge")).toHaveTextContent(/open/i);

  await row.getByRole("combobox").selectOptions("resolved");

  await expect.element(row.getByTestId("status-badge")).toHaveTextContent(/resolved/i);
  await expect.element(row.getByTestId("status-badge")).not.toHaveTextContent(/open/i);
});
