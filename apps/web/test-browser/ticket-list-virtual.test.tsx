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
import { TicketList } from "@/components/ticket-list";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) for app-shell の TicketList 仮想化
// (spec: specs/app-shell.md component観点). 仮想化は実ブラウザのスクロール+
// レイアウト計測でしか検証できないため BM が担当層。TicketList は静的 props で
// 駆動し(テストがデータを所有)、唯一の seam は onEndReached / onStatusChange の
// spy。ネットワークもバックエンドも要らない — レンダリングと spy を観測する。
//
// 仕様が固定する仮想化契約:
// - height 指定でマウントすると、DOM 上の ticket-row は総数(500)より大幅に
//   少ない(< 50)。可視ウィンドウ + オーバースキャンぶんだけが実体化する。
// - スクロールで後半の行(450件目の subject)が実体化して現れる。
// - 末尾近くまでスクロールすると onEndReached が呼ばれる(可視末尾が末尾-5行に
//   達したとき。仕様のインフィニティスクロールのトリガ)。
//
// TicketList は subject を router <Link> として描画するため router context が要る
// (ticket-status.test.tsx の流儀)。使い捨ての route ツリーで /tickets/$id を宣言する。

const TOTAL = 500;
const TICKETS: Ticket[] = Array.from({ length: TOTAL }, (_, i) => {
  const n = i + 1;
  return {
    id: `t${n}`,
    number: n,
    subject: `Bulk ticket ${n}`,
    status: "open",
    priority: "medium",
    requesterEmail: "customer@example.com",
    assigneeEmail: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
});

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

// 仮想スクロール要素は ticket-list(仕様: スクロール領域に data-testid="ticket-list")。
// scrollTop を押し上げて末尾行の実体化・onEndReached を促す。固定待ちは使わず、
// 目的の状態が満たされるまで vi.waitFor でスクロール→検証を繰り返す。
function scroller() {
  return page.getByTestId("ticket-list");
}

test(
  "500件を height 指定でマウントしても DOM 行数は総数より大幅に少ない(仮想化)",
  {
    annotation: {
      type: "description",
      description:
        "TicketList に500件と height を渡してマウントすると、DOM 上の ticket-row 数が総数500より大幅に少ない(< 50)ことを検証。可視ウィンドウ+オーバースキャンだけが実体化する(仮想化の基本契約)",
    },
  },
  async () => {
    await renderInRouter(<TicketList tickets={TICKETS} onStatusChange={vi.fn()} height={480} />);

    // 先頭行は見える(部分一致だと 10..19 等にも当たるため番号の直後を非数字に固定)。
    await expect
      .element(page.getByTestId("ticket-row").filter({ hasText: /Bulk ticket 1(?!\d)/ }))
      .toBeVisible();
    // 総数500に対し、実体化した行は大幅に少ない。
    expect(page.getByTestId("ticket-row").elements().length).toBeLessThan(50);
  },
);

test(
  "スクロールで後半の行(450件目)が実体化して現れる",
  {
    annotation: {
      type: "description",
      description:
        "仮想化された一覧を下方向へスクロールすると、初期表示では DOM に無かった後半の行(450件目の subject『Bulk ticket 450』)が実体化して可視になることを検証",
    },
  },
  async () => {
    await renderInRouter(<TicketList tickets={TICKETS} onStatusChange={vi.fn()} height={480} />);

    // 初期状態では450件目は実体化していない。
    expect(
      page.getByTestId("ticket-row").filter({ hasText: "Bulk ticket 450" }).elements(),
    ).toHaveLength(0);

    // 行高固定 48px(仕様)なので 450件目の概位置(=449*48)へスクロールする。
    // レイアウト計測に依存せず目標行が現れるまで繰り返す(固定待ちなし)。
    const target = page.getByTestId("ticket-row").filter({ hasText: "Bulk ticket 450" });
    await vi.waitFor(() => {
      scroller()
        .element()
        .scrollTo({ top: 449 * 48 });
      expect(target.elements().length).toBeGreaterThan(0);
    });
    await expect.element(target).toBeVisible();
  },
);

test(
  "末尾近くまでスクロールすると onEndReached が呼ばれる",
  {
    annotation: {
      type: "description",
      description:
        "仮想化された一覧を最下部までスクロールし、可視末尾が末尾-5行に達すると onEndReached コールバックが呼ばれることを検証(インフィニティスクロールの次ページ fetch トリガ)",
    },
  },
  async () => {
    const onEndReached = vi.fn();
    await renderInRouter(
      <TicketList
        tickets={TICKETS}
        onStatusChange={vi.fn()}
        onEndReached={onEndReached}
        height={480}
      />,
    );

    await vi.waitFor(() => {
      scroller()
        .element()
        .scrollTo({ top: TOTAL * 48 });
      expect(onEndReached).toHaveBeenCalled();
    });
  },
);
