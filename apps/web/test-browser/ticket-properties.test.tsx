import { page } from "@vitest/browser/context";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TicketProperties } from "@/components/ticket-properties";
import type { Label, Ticket } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) for detail-panel's properties aside
// (spec: specs/detail-panel.md プロパティパネル / component 観点). TicketProperties
// is a presentational component: data fetching is the route's responsibility, so
// the test owns the data via static props and needs no orpc client or router —
// it mounts the component directly and observes the render + callbacks.
//
// Public shape pinned by the spec (§プロパティパネル):
//   TicketProperties({ ticket, role, agents, labelCatalog,
//     onStatusChange, onAssigneeChange, onLabelsChange })
// Row testids the spec fixes (agent): ticket-status-select, assignee-select,
// label-toggle-{name}, ticket-requester, ticket-labels > ticket-label.
// Customer: status-badge + read-only text, no select/toggle.
// Dates: createdAt/updatedAt rendered as `YYYY-MM-DD HH:mm` in UTC (TZ 非依存)。

const AGENTS = [
  { email: "agent@example.com", name: "Agent Smith" },
  { email: "second@example.com", name: "Second Agent" },
];

const CATALOG: Label[] = [
  { name: "api", color: "#e2626b" },
  { name: "billing", color: "#4f8ff7" },
  { name: "auth", color: "#3fb950" },
];

// Fixed ISO instants so the UTC date-format assertion is deterministic. The
// minutes carry a non-zero value so a naive local-TZ render would visibly drift.
const TICKET: Ticket = {
  id: "t1",
  number: 7,
  subject: "Cannot login to dashboard",
  status: "open",
  priority: "high",
  requesterEmail: "customer@example.com",
  assigneeEmail: "agent@example.com",
  labels: [{ name: "api", color: "#e2626b" }],
  createdAt: "2026-01-03T04:05:00.000Z",
  updatedAt: "2026-01-04T09:30:00.000Z",
};

test(
  "agent マウントで各コントロールが出て、操作でコールバックが正しい引数で呼ばれる",
  {
    annotation: {
      type: "description",
      description:
        "agent ロールで status/assignee/label のコントロールが描画され、状態セレクトで in_progress を選ぶと onStatusChange('in_progress')、担当者セレクトで別 agent を選ぶと onAssigneeChange(そのemail)・未割り当てで null、未付与ラベルのトグルで onLabelsChange が全置換配列(既存 + 追加)で呼ばれることを検証",
    },
  },
  async () => {
    const onStatusChange = vi.fn();
    const onAssigneeChange = vi.fn();
    const onLabelsChange = vi.fn();
    const onPriorityChange = vi.fn();
    // render() は同期に結果を返すが lint 型上は thenable 扱いなので void で明示破棄する。
    void render(
      <TicketProperties
        ticket={TICKET}
        role="agent"
        agents={AGENTS}
        labelCatalog={CATALOG}
        onStatusChange={onStatusChange}
        onAssigneeChange={onAssigneeChange}
        onLabelsChange={onLabelsChange}
        onPriorityChange={onPriorityChange}
      />,
    );

    // 各コントロールが可視であること(存在の下限)。
    await expect.element(page.getByTestId("ticket-status-select")).toBeVisible();
    await expect.element(page.getByTestId("assignee-select")).toBeVisible();
    await expect.element(page.getByTestId("priority-select")).toBeVisible();
    for (const label of CATALOG) {
      await expect.element(page.getByTestId(`label-toggle-${label.name}`)).toBeVisible();
    }

    // 状態変更: 生値 in_progress でコールバック。
    await page.getByTestId("ticket-status-select").selectOptions("in_progress");
    expect(onStatusChange).toHaveBeenLastCalledWith("in_progress");

    // 優先度変更: 生値でコールバック。TICKET.priority は high なので別値 low を選ぶ。
    await page.getByTestId("priority-select").selectOptions("low");
    expect(onPriorityChange).toHaveBeenLastCalledWith("low");

    // 担当者変更: 別 agent の email。
    await page.getByTestId("assignee-select").selectOptions("second@example.com");
    expect(onAssigneeChange).toHaveBeenLastCalledWith("second@example.com");

    // 未割り当て(値 "")は null に正規化して渡す。
    await page.getByTestId("assignee-select").selectOptions("");
    expect(onAssigneeChange).toHaveBeenLastCalledWith(null);

    // ラベルトグル: 未付与の "billing" を押すと既存 api を含む全置換配列で呼ぶ。
    await page.getByTestId("label-toggle-billing").click();
    expect(onLabelsChange).toHaveBeenLastCalledWith(expect.arrayContaining(["api", "billing"]));

    // 敵対的レビューの反例の固定: 解除方向。付与済み "api" のトグルを押すと
    // api を含まない全置換配列で呼ぶ(add-only 化ミューテーションを殺す)。
    await page.getByTestId("label-toggle-api").click();
    expect(onLabelsChange).toHaveBeenLastCalledWith(expect.not.arrayContaining(["api"]));
  },
);

test(
  "agent マウントで依頼者と日付が YYYY-MM-DD HH:mm(UTC)で表示される",
  {
    annotation: {
      type: "description",
      description:
        "agent ロールで ticket-requester に requesterEmail が出て、createdAt(2026-01-03T04:05Z)が『2026-01-03 04:05』、updatedAt(2026-01-04T09:30Z)が『2026-01-04 09:30』と UTC・YYYY-MM-DD HH:mm 形式で表示されることを検証",
    },
  },
  async () => {
    // render() は同期に結果を返すが lint 型上は thenable 扱いなので void で明示破棄する。
    void render(
      <TicketProperties
        ticket={TICKET}
        role="agent"
        agents={AGENTS}
        labelCatalog={CATALOG}
        onStatusChange={vi.fn()}
        onAssigneeChange={vi.fn()}
        onLabelsChange={vi.fn()}
        onPriorityChange={vi.fn()}
      />,
    );

    await expect
      .element(page.getByTestId("ticket-requester"))
      .toHaveTextContent("customer@example.com");
    // UTC 固定の日付表示(ローカル TZ に依存させない — spec 備考)。
    const panel = page.getByTestId("ticket-properties");
    await expect.element(panel).toHaveTextContent("2026-01-03 04:05");
    await expect.element(panel).toHaveTextContent("2026-01-04 09:30");
  },
);

test(
  "customer マウントでコントロールが無く、状態バッジ・ラベルチップ・依頼者が表示のみになる",
  {
    annotation: {
      type: "description",
      description:
        "customer ロールで status/assignee セレクト・ラベルトグルが一切描画されず、代わりに status-badge・付与済み ticket-label チップ・ticket-requester が閲覧表示され、agents/labelCatalog を空配列で渡しても破綻しないことを検証",
    },
  },
  async () => {
    // render() は同期に結果を返すが lint 型上は thenable 扱いなので void で明示破棄する。
    void render(
      <TicketProperties
        ticket={TICKET}
        role="customer"
        agents={[]}
        labelCatalog={[]}
        onStatusChange={vi.fn()}
        onAssigneeChange={vi.fn()}
        onLabelsChange={vi.fn()}
        onPriorityChange={vi.fn()}
      />,
    );

    // 操作コントロールは一切出さない。
    await expect.element(page.getByTestId("ticket-properties")).toBeVisible();
    expect(page.getByTestId("ticket-status-select").elements()).toHaveLength(0);
    expect(page.getByTestId("assignee-select").elements()).toHaveLength(0);
    expect(page.getByTestId("priority-select").elements()).toHaveLength(0);
    expect(page.getByTestId(/^label-toggle-/).elements()).toHaveLength(0);

    // 閲覧表示: 状態バッジ・付与済みラベルチップ・依頼者・優先度テキスト(capitalize)。
    await expect.element(page.getByTestId("status-badge")).toBeVisible();
    await expect
      .element(page.getByTestId("ticket-labels").getByTestId("ticket-label").first())
      .toHaveTextContent("api");
    await expect
      .element(page.getByTestId("ticket-requester"))
      .toHaveTextContent("customer@example.com");
    // TICKET.priority は high。customer は生値でなく capitalize 表示のみ。
    await expect.element(page.getByTestId("ticket-properties")).toHaveTextContent("High");
  },
);
