import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { TicketList } from "./ticket-list";
import type { Ticket } from "@/lib/tickets";

const TICKETS: Ticket[] = [
  {
    id: "t1",
    number: 1,
    subject: "Cannot sign in from SSO",
    status: "open",
    priority: "high",
    requesterEmail: "casey@example.com",
    assigneeEmail: null,
    labels: [{ name: "auth", color: "#e2626b" }],
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
  },
  {
    id: "t2",
    number: 2,
    subject: "Invoice PDF renders blank",
    status: "in_progress",
    priority: "medium",
    requesterEmail: "morgan@example.com",
    assigneeEmail: "agent@example.com",
    labels: [{ name: "billing", color: "#f2c94c" }],
    createdAt: "2026-07-02T09:00:00.000Z",
    updatedAt: "2026-07-02T09:00:00.000Z",
  },
  {
    id: "t3",
    number: 3,
    subject: "Feature request: weekly digest",
    status: "resolved",
    priority: "low",
    requesterEmail: "sam@example.com",
    assigneeEmail: null,
    labels: [],
    createdAt: "2026-07-03T09:00:00.000Z",
    updatedAt: "2026-07-03T09:00:00.000Z",
  },
];

// 行の subject は router の Link なので、ストーリー自身がルーターを持つ
// (test-browser/kanban.test.tsx の renderInRouter と同じ最小ツリー)。
function StoryRouter({ children }: { children: React.ReactNode }) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{children}</>,
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
  return <RouterProvider router={router} />;
}

// VRT カタログストーリー: 3ステータスの行を1枚で。
export const VisualCatalog = () => (
  <StoryRouter>
    {/* 行は固定幅カラムのグリッドなので、カタログも実画面相当の幅で撮る。 */}
    <div className="w-[60rem] bg-background p-6">
      <TicketList tickets={TICKETS} onStatusChange={() => {}} />
    </div>
  </StoryRouter>
);
