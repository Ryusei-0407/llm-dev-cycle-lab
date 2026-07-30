import { page } from "@vitest/browser/context";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { KanbanBoard } from "@/components/kanban-board";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) — the spec's headline case
// (specs/kanban.md「本命検証対象」): a real browser HTML5 drag-and-drop that
// JSDOM cannot reproduce. The board is driven by local state so the test owns
// the data; the only injected seam is `onSetStatus`, a spy standing in for the
// orpc.tickets.setStatus mutation. We observe the render and the spy, not the
// network.
//
// Props shape assumed from the spec (reported to the parent):
//   KanbanBoard({
//     tickets: Ticket[],                                   // agent = 全件
//     onSetStatus: (id, status) => Promise<void>,          // drop 時に呼ぶ。
//   })
// The board groups `tickets` by status into the three columns itself and moves
// a card between columns only after `onSetStatus` resolves (spec: 「成功で列間
// 移動を確定」). A rejected `onSetStatus` shows board-error and leaves the card
// in its original column (spec の失敗ケース = 巻き戻し/据え置き)。
//
// KanbanBoard renders card subjects as router <Link>s in the same idiom as
// TicketList, so it must mount under a router context (ticket-status.test.tsx
// の流儀)。The /tickets/$id target is declared so those links resolve.

const seed: Ticket[] = [
  {
    id: "t1",
    subject: "Cannot login to dashboard",
    status: "open",
    priority: "high",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-03T00:00:00.000Z",
  },
  {
    id: "t2",
    subject: "Billing question",
    status: "in_progress",
    priority: "medium",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "t3",
    subject: "Feature request: dark mode",
    status: "resolved",
    priority: "low",
    requesterEmail: "customer@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "t4",
    subject: "Password reset email missing",
    status: "open",
    priority: "medium",
    requesterEmail: "other@example.com",
    createdAt: "2026-01-04T00:00:00.000Z",
  },
];

// A throwaway route tree that renders `element` at "/" and declares the
// "/tickets/$id" target so the board's card <Link>s resolve. Kept local so it
// doesn't drag in the app's loaders/auth redirects.
async function renderInRouter(element: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => element,
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

// Drives a real HTML5 drag-and-drop between two elements. A single shared
// DataTransfer instance threads through the sequence, mirroring the browser's
// own drag data channel — dragstart writes the ticket id, drop reads it. Each
// event carries `bubbles: true` so it reaches the column's handler via
// delegation, and `cancelable: true` so the board's preventDefault on dragover
// (required to make an element a valid drop target) takes effect.
async function dragCardTo(card: Element, target: Element) {
  const dataTransfer = new DataTransfer();
  const fire = (el: Element, type: string) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));

  fire(card, "dragstart");
  fire(target, "dragenter");
  fire(target, "dragover");
  fire(target, "drop");
  fire(card, "dragend");
}

test(
  "groups tickets into status columns with per-column count badges",
  {
    annotation: {
      type: "description",
      description:
        "渡したチケットが Open / In progress / Resolved の3列へ status ごとに振り分けられ、各列の件数バッジが列内のカード数と一致することを検証",
    },
  },
  async () => {
    await renderInRouter(<KanbanBoard tickets={seed} onSetStatus={vi.fn()} />);

    const open = page.getByTestId("kanban-column-open");
    const inProgress = page.getByTestId("kanban-column-in_progress");
    const resolved = page.getByTestId("kanban-column-resolved");

    // 各列に正しいカードが入る(seed: open=2, in_progress=1, resolved=1)。
    await expect.element(open.getByTestId("kanban-card").first()).toBeVisible();
    await expect(open.getByTestId("kanban-card").elements()).toHaveLength(2);
    await expect(inProgress.getByTestId("kanban-card").elements()).toHaveLength(1);
    await expect(resolved.getByTestId("kanban-card").elements()).toHaveLength(1);

    // 件数バッジは列内カード数に一致する。
    await expect.element(open.getByTestId("column-count")).toHaveTextContent("2");
    await expect.element(inProgress.getByTestId("column-count")).toHaveTextContent("1");
    await expect.element(resolved.getByTestId("column-count")).toHaveTextContent("1");

    // カードは subject と priority を表示する。
    await expect
      .element(open.getByTestId("kanban-card").first())
      .toHaveTextContent("Cannot login to dashboard");
  },
);

test(
  "moves a card between columns on a real drag-and-drop and calls setStatus",
  {
    annotation: {
      type: "description",
      description:
        "実ブラウザの DragEvent で open 列のカードを in_progress 列へドラッグ&ドロップすると onSetStatus が {id, status:'in_progress'} で呼ばれ、成功後にカードが in_progress 列へ移動することを検証(Browser Mode の本命)",
    },
  },
  async () => {
    const onSetStatus = vi.fn(async () => {});
    await renderInRouter(<KanbanBoard tickets={seed} onSetStatus={onSetStatus} />);

    const open = page.getByTestId("kanban-column-open");
    const inProgress = page.getByTestId("kanban-column-in_progress");

    const card = open.getByTestId("kanban-card").filter({ hasText: "Cannot login to dashboard" });
    await expect.element(card).toBeVisible();

    await dragCardTo(card.element(), inProgress.element());

    // drop で setStatus が「移動先の status」で呼ばれる。
    await vi.waitFor(() => {
      expect(onSetStatus).toHaveBeenCalledWith("t1", "in_progress");
    });

    // 成功後、カードは in_progress 列へ移り、open 列からは消える。件数バッジも追従。
    await expect
      .element(
        inProgress.getByTestId("kanban-card").filter({ hasText: "Cannot login to dashboard" }),
      )
      .toBeVisible();
    await expect(
      open.getByTestId("kanban-card").filter({ hasText: "Cannot login to dashboard" }).elements(),
    ).toHaveLength(0);
    await expect.element(open.getByTestId("column-count")).toHaveTextContent("1");
    await expect.element(inProgress.getByTestId("column-count")).toHaveTextContent("2");
  },
);

test(
  "shows board-error and leaves the card in place when setStatus rejects",
  {
    annotation: {
      type: "description",
      description:
        "onSetStatus が reject したとき board-error が表示され、ドラッグしたカードが元の列(open)に残る(移動が確定しない)ことを検証",
    },
  },
  async () => {
    const onSetStatus = vi.fn(async () => {
      throw new Error("setStatus failed");
    });
    await renderInRouter(<KanbanBoard tickets={seed} onSetStatus={onSetStatus} />);

    const open = page.getByTestId("kanban-column-open");
    const inProgress = page.getByTestId("kanban-column-in_progress");

    const card = open.getByTestId("kanban-card").filter({ hasText: "Cannot login to dashboard" });
    await dragCardTo(card.element(), inProgress.element());

    // 失敗時は専用エラーを出す。
    await expect.element(page.getByTestId("board-error")).toBeVisible();

    // カードは元の open 列に留まり、in_progress へは移らない(巻き戻し/据え置き)。
    await expect
      .element(open.getByTestId("kanban-card").filter({ hasText: "Cannot login to dashboard" }))
      .toBeVisible();
    await expect(
      inProgress
        .getByTestId("kanban-card")
        .filter({ hasText: "Cannot login to dashboard" })
        .elements(),
    ).toHaveLength(0);
    await expect.element(open.getByTestId("column-count")).toHaveTextContent("2");
  },
);
