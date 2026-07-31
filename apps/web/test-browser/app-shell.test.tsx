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
import { AppShell } from "@/components/app-shell";
import type { User } from "@/auth/api";

// Component-layer test (Vitest Browser Mode) for the App shell sidebar の
// ロール出し分け(spec: specs/app-shell.md component観点). AppShell は user prop
// だけで駆動し(テストがデータを所有)、children はマーカーを流し込む。ネットワークも
// バックエンドも要らない — レンダリングを観測する。
//
// 仕様が固定する出し分け契約:
// - nav コンテナは data-testid="app-sidebar"。
// - nav-tickets は全ロールで出る。
// - nav-board は agent のみ(customer にはレンダリングしない — 既存 TopNav と同じ)。
// - 下端に current-user(user.name)。
//
// AppShell はサイドバー内に router <Link>(Tickets / Board)を描画するため、
// router context 下でマウントする(ticket-status.test.tsx の流儀)。リンク先の
// /tickets と /board を宣言する。

const agent: User = {
  id: "u-agent",
  email: "agent@example.com",
  role: "agent",
  name: "Aki Agent",
};

const customer: User = {
  id: "u-customer",
  email: "customer@example.com",
  role: "customer",
  name: "Chika Customer",
};

async function renderInRouter(element: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => element,
  });
  const ticketsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tickets",
    component: () => null,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/board",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, ticketsRoute, boardRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

test(
  "agent のサイドバーは Tickets と Board のリンクを出す",
  {
    annotation: {
      type: "description",
      description:
        "AppShell に agent ユーザーを渡すと、app-sidebar 内に nav-tickets と nav-board(agent 専用リンク)がともに描画され、下端に current-user(user.name)が表示されることを検証",
    },
  },
  async () => {
    await renderInRouter(
      <AppShell user={agent}>
        <div data-testid="__main">main</div>
      </AppShell>,
    );

    const sidebar = page.getByTestId("app-sidebar");
    await expect.element(sidebar).toBeVisible();
    await expect.element(sidebar.getByTestId("nav-tickets")).toBeVisible();
    await expect.element(sidebar.getByTestId("nav-board")).toBeVisible();
    await expect.element(sidebar.getByTestId("current-user")).toHaveTextContent("Aki Agent");
    // children はメインペインへ流し込まれる。
    await expect.element(page.getByTestId("__main")).toBeVisible();
  },
);

test(
  "customer のサイドバーは Board リンクを出さない(Tickets は出す)",
  {
    annotation: {
      type: "description",
      description:
        "AppShell に customer ユーザーを渡すと、app-sidebar 内に nav-tickets は描画されるが nav-board(agent 専用)は描画されない(既存 TopNav と同じロール出し分け)ことを検証",
    },
  },
  async () => {
    await renderInRouter(
      <AppShell user={customer}>
        <div data-testid="__main">main</div>
      </AppShell>,
    );

    const sidebar = page.getByTestId("app-sidebar");
    await expect.element(sidebar).toBeVisible();
    await expect.element(sidebar.getByTestId("nav-tickets")).toBeVisible();
    expect(sidebar.getByTestId("nav-board").elements()).toHaveLength(0);
    await expect.element(sidebar.getByTestId("current-user")).toHaveTextContent("Chika Customer");
  },
);
