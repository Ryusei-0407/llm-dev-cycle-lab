import { page } from "@vitest/browser/context";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { TicketList } from "@/components/ticket-list";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) for ticket-model's list-row
// additions (spec: specs/ticket-model.md UI 一覧). TicketList is driven by
// static props so the test owns the data and needs no orpc client or backend —
// it observes the render only. TicketList already mounts <Link>s per subject, so
// it needs a router context (ticket-status.test.tsx の流儀); a throwaway route
// tree declares the /tickets/$id target the links resolve to.
//
// Row testids the spec fixes: ticket-number (`SUP-${number}`),
// ticket-labels > ticket-label (name text + color via style), ticket-assignee
// (assigneeEmail の @ 前、未割り当ては `–`).

const TICKETS: Ticket[] = [
  {
    id: "t1",
    number: 1,
    subject: "Cannot login to dashboard",
    status: "open",
    priority: "high",
    requesterEmail: "customer@example.com",
    assigneeEmail: null,
    labels: [{ name: "auth", color: "#e2626b" }],
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
  },
  {
    id: "t2",
    number: 2,
    subject: "Billing question",
    status: "in_progress",
    priority: "medium",
    requesterEmail: "customer@example.com",
    assigneeEmail: "agent@example.com",
    labels: [
      { name: "billing", color: "#f2c94c" },
      { name: "api", color: "#6a8dff" },
    ],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "t3",
    number: 3,
    subject: "Feature request: dark mode",
    status: "resolved",
    priority: "low",
    requesterEmail: "customer@example.com",
    assigneeEmail: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

async function renderInRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <TicketList tickets={TICKETS} onStatusChange={() => {}} />,
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
  await router.load();
  return render(<RouterProvider router={router} />);
}

// Helper: the row for a given subject (rows are keyed by ticket-row testid).
function rowFor(subject: string) {
  return page.getByTestId("ticket-row").filter({ hasText: subject });
}

test(
  "各行に SUP-番号 を表示する",
  {
    annotation: {
      type: "description",
      description:
        "各チケット行の ticket-number が `SUP-${number}` 形式(SUP-1 / SUP-2 / SUP-3)で表示されることを検証",
    },
  },
  async () => {
    await renderInRouter();
    await expect
      .element(rowFor("Cannot login to dashboard").getByTestId("ticket-number"))
      .toHaveTextContent("SUP-1");
    await expect
      .element(rowFor("Billing question").getByTestId("ticket-number"))
      .toHaveTextContent("SUP-2");
    await expect
      .element(rowFor("Feature request: dark mode").getByTestId("ticket-number"))
      .toHaveTextContent("SUP-3");
  },
);

test(
  "担当者を name(@前)で表示し、未割り当ては – を表示する",
  {
    annotation: {
      type: "description",
      description:
        "ticket-assignee が担当者メールの @ 前(agent@example.com → agent)を表示し、未割り当てのチケットでは `–` を表示することを検証",
    },
  },
  async () => {
    await renderInRouter();
    await expect
      .element(rowFor("Billing question").getByTestId("ticket-assignee"))
      .toHaveTextContent("agent");
    await expect
      .element(rowFor("Cannot login to dashboard").getByTestId("ticket-assignee"))
      .toHaveTextContent("–");
  },
);

test(
  "ラベル0件・1件・複数件をそれぞれ描画する",
  {
    annotation: {
      type: "description",
      description:
        "ticket-labels 配下の ticket-label が、ラベル0件の行では0個、1件の行では1個(auth)、複数件の行では件数分描画されることを検証",
    },
  },
  async () => {
    await renderInRouter();

    // 1件: auth
    const single = rowFor("Cannot login to dashboard").getByTestId("ticket-label");
    await expect(single.elements()).toHaveLength(1);
    await expect.element(single).toHaveTextContent("auth");

    // 複数件: billing + api
    const multi = rowFor("Billing question").getByTestId("ticket-label");
    await expect(multi.elements()).toHaveLength(2);

    // 0件: ticket-label は無い
    await expect(
      rowFor("Feature request: dark mode").getByTestId("ticket-label").elements(),
    ).toHaveLength(0);
  },
);

test(
  "各ラベルは color を style に反映する",
  {
    annotation: {
      type: "description",
      description:
        "ticket-label が対応する Label.color を要素の style(background 等)に反映していることを検証(auth の #e2626b が style 文字列に現れる)",
    },
  },
  async () => {
    await renderInRouter();
    const authLabel = rowFor("Cannot login to dashboard").getByTestId("ticket-label");
    // 見た目の詳細(どのプロパティか)は自由なので、style 属性に色値が含まれることだけを見る。
    // ブラウザは #rrggbb を rgb(...) に正規化しうるため、両表記のいずれかを許容する。
    const el = authLabel.element() as HTMLElement;
    const style = el.getAttribute("style") ?? "";
    expect(/#e2626b|226,\s*98,\s*107/i.test(style)).toBe(true);
  },
);
