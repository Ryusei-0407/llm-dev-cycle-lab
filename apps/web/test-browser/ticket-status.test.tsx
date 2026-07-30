import { page } from "@vitest/browser/context";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { TicketList } from "@/components/ticket-list";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode): verifies that changing a
// ticket's status re-paints the status badge immediately in a real browser.
// The list is driven by local state so the test owns the data and needs no
// tRPC client or backend — it observes the render, not the network.
//
// TicketList now renders each subject as a router <Link>, so it must mount under
// a router context. We wrap it in a minimal in-memory router whose only routes
// are the ones the list links to (/tickets/$id); the assertion is unchanged.

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

// A throwaway route tree that renders the Harness at "/" and declares the
// "/tickets/$id" target so the list's <Link> resolves. Kept local to this test
// so it doesn't drag in the app's loaders/auth redirects.
async function renderInRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Harness,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tickets/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Resolve the initial match before mounting so RouterProvider renders the
  // matched route synchronously (an unresolved router renders a pending tree
  // whose internals read a not-yet-populated context).
  await router.load();
  return render(<RouterProvider router={router} />);
}

test("repaints the status badge immediately when status changes", async () => {
  await renderInRouter();

  const row = page.getByTestId("ticket-row");
  await expect.element(row.getByTestId("status-badge")).toHaveTextContent(/open/i);

  await row.getByRole("combobox").selectOptions("resolved");

  await expect.element(row.getByTestId("status-badge")).toHaveTextContent(/resolved/i);
  await expect.element(row.getByTestId("status-badge")).not.toHaveTextContent(/open/i);
});
