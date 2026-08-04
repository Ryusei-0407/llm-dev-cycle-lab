import { page } from "@vitest/browser/context";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { TicketList } from "@/components/ticket-list";
import { isEditableTarget, nextActiveIndex } from "@/lib/list-keys";
import type { Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) for keyboard-nav の一覧ハイライト移動
// (spec: specs/keyboard-nav.md テスト観点 BM). document レベルの keydown 駆動と
// data-active の可視反映は実ブラウザでしか検証できないため BM が担当層。
//
// 仕様の制約(実装メモ)により、アクティブ行の状態はページ(route)側が持ち、
// TicketList にはプロパティで渡す。この BM ではその「ページの役割」を最小の
// Harness で再現する: document keydown を購読し、仕様の純ロジック(list-keys の
// nextActiveIndex / isEditableTarget)でアクティブ index を更新して TicketList に
// 渡す。テストが観測するのは TicketList 側の DOM 契約(該当 ticket-row に
// data-active="true" と bg-surface-2、非アクティブ行には data-active を付けない、
// input フォーカス中は keydown を無視して動かない)。
//
// 仕様の曖昧さ: TicketList にアクティブ行を渡す prop 名は仕様が固定していない
// (「プロパティで渡す」とだけ)。ここでは activeIndex と仮定する。実装が別名を
// 採るなら Harness の prop 名を合わせること(DOM 契約側のアサーションは不変)。

const TICKETS: Ticket[] = Array.from({ length: 5 }, (_, i) => {
  const n = i + 1;
  return {
    id: `t${n}`,
    number: n,
    subject: `Row ${n}`,
    status: "open",
    priority: "medium",
    requesterEmail: "customer@example.com",
    assigneeEmail: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
});

// The page's role, reproduced from the spec's pure logic: a document keydown
// listener that ignores editable targets and modifier keys, moves the active
// index with nextActiveIndex, and passes it to TicketList. Also renders a bare
// search input so the "input focus disables movement" guard can be exercised.
function Harness() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        setActiveIndex((current) => nextActiveIndex(current, 1, TICKETS.length));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        setActiveIndex((current) => nextActiveIndex(current, -1, TICKETS.length));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div>
      <input data-testid="search-input" aria-label="Search" />
      <TicketList tickets={TICKETS} onStatusChange={() => {}} activeIndex={activeIndex} />
    </div>
  );
}

async function renderHarness() {
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
  await router.load();
  return render(<RouterProvider router={router} />);
}

// 指定 subject の ticket-row を返す(番号の直後を非数字に固定して 1 と 10.. の
// 部分一致衝突を避ける)。
function row(n: number) {
  return page.getByTestId("ticket-row").filter({ hasText: new RegExp(`Row ${n}(?!\\d)`) });
}

test(
  "j / k で data-active が次の行・前の行へ移動し、該当行に bg-surface-2 が付く",
  {
    annotation: {
      type: "description",
      description:
        "一覧に対し document keydown で j を押すと先頭行(Row 1)に data-active='true' と bg-surface-2 が付き、もう一度 j で 2 行目(Row 2)へ移り前の行から data-active が外れ、k で 1 行目へ戻ることを実ブラウザで検証(非アクティブ行には data-active を付けない)",
    },
  },
  async () => {
    await renderHarness();
    await expect.element(row(1)).toBeVisible();
    // 初期は未選択: data-active な行が無い。
    expect(
      document.querySelectorAll("[data-testid='ticket-row'][data-active='true']"),
    ).toHaveLength(0);

    // j: 先頭行がアクティブになり bg-surface-2 が付く。
    await page.getByTestId("ticket-list").click();
    await page.keyboard.press("j");
    await expect.element(row(1)).toHaveAttribute("data-active", "true");
    await expect.element(row(1)).toHaveClass(/bg-surface-2/);

    // j: 2 行目へ移り、1 行目の data-active は外れる。
    await page.keyboard.press("j");
    await expect.element(row(2)).toHaveAttribute("data-active", "true");
    await expect.element(row(1)).not.toHaveAttribute("data-active", "true");

    // k: 1 行目へ戻る。
    await page.keyboard.press("k");
    await expect.element(row(1)).toHaveAttribute("data-active", "true");
    await expect.element(row(2)).not.toHaveAttribute("data-active", "true");
  },
);

test(
  "input へフォーカス中は j を押してもアクティブ行が動かない",
  {
    annotation: {
      type: "description",
      description:
        "検索用 input にフォーカスした状態で j を押しても、isEditableTarget ガードにより keydown が無視され、アクティブ行が発生しない(data-active な行が 0 のまま)ことを実ブラウザで検証",
    },
  },
  async () => {
    await renderHarness();
    await expect.element(row(1)).toBeVisible();

    await page.getByTestId("search-input").click();
    await expect.element(page.getByTestId("search-input")).toBeFocused();
    await page.keyboard.press("j");

    // input フォーカス中の j は無視され、どの行もアクティブにならない。
    expect(
      document.querySelectorAll("[data-testid='ticket-row'][data-active='true']"),
    ).toHaveLength(0);
  },
);
