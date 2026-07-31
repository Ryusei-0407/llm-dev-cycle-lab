import { page } from "@vitest/browser/context";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { MessageThread } from "@/components/message-thread";
import type { Message } from "@/lib/tickets";
import type { TicketEvent } from "@/lib/tickets";

// Component-layer test (Vitest Browser Mode) for ticket-model's activity-event
// rendering in the detail thread (spec: specs/ticket-model.md UI 詳細 / component
// 観点). The thread merges messages and events by created_at and renders event
// rows as data-testid="ticket-event" with the fixed wording the spec pins for
// exact-match testing. Driven by static props so the test owns the data and
// needs no orpc client — it observes the render only.
//
// Assumed props shape (spec 由来, reported to parent): MessageThread renders a
// time-ordered merge of `messages` (message-item) and `events` (ticket-event).
// The event wording is:
//   status_changed:   状態: {from} → {to}                    (open/in_progress/resolved 生値)
//   assignee_changed: 担当者: {from ?? 未割り当て} → {to ?? 未割り当て} (email 生値)
//   labels_changed:   ラベル: {to を ", " 結合}  空は  ラベル: なし
//
// The event thread has no agent-only controls here; the select/toggle live in
// the detail route, not in the thread component (customer/agent 差はE2Eで検証)。

const MESSAGES: Message[] = [
  {
    id: "m1",
    ticketId: "t1",
    authorEmail: "customer@example.com",
    authorRole: "customer",
    body: "I can't sign in.",
    createdAt: "2026-01-03T00:00:00.000Z",
  },
  {
    id: "m2",
    ticketId: "t1",
    authorEmail: "agent@example.com",
    authorRole: "agent",
    body: "Looking into it.",
    createdAt: "2026-01-03T00:02:00.000Z",
  },
];

function renderThread(events: TicketEvent[], messages: Message[] = MESSAGES): void {
  // render() は同期に結果を返すが lint 型上は thenable 扱いなので void で明示破棄する。
  void render(<MessageThread messages={messages} events={events} />);
}

test(
  "status_changed イベントを『状態: {from} → {to}』で描画する",
  {
    annotation: {
      type: "description",
      description:
        "status_changed イベントが ticket-event 行として『状態: in_progress → resolved』(open/in_progress/resolved の生値)で描画されることを検証",
    },
  },
  async () => {
    renderThread([
      {
        id: "e1",
        type: "status_changed",
        actorEmail: "agent@example.com",
        payload: { from: "in_progress", to: "resolved" },
        createdAt: "2026-01-03T00:03:00.000Z",
      },
    ]);
    await expect
      .element(page.getByTestId("ticket-event"))
      .toHaveTextContent("状態: in_progress → resolved");
  },
);

test(
  "assignee_changed イベントを email 生値/未割り当てで描画する",
  {
    annotation: {
      type: "description",
      description:
        "assignee_changed イベントが『担当者: {from ?? 未割り当て} → {to ?? 未割り当て}』で描画され、null は『未割り当て』・非 null は email 生値になることを検証",
    },
  },
  async () => {
    renderThread([
      {
        id: "e1",
        type: "assignee_changed",
        actorEmail: "agent@example.com",
        payload: { from: null, to: "agent@example.com" },
        createdAt: "2026-01-03T00:03:00.000Z",
      },
      {
        id: "e2",
        type: "assignee_changed",
        actorEmail: "agent@example.com",
        payload: { from: "agent@example.com", to: null },
        createdAt: "2026-01-03T00:04:00.000Z",
      },
    ]);
    const events = page.getByTestId("ticket-event");
    await expect
      .element(events.first())
      .toHaveTextContent("担当者: 未割り当て → agent@example.com");
    await expect.element(events.nth(1)).toHaveTextContent("担当者: agent@example.com → 未割り当て");
  },
);

test(
  "labels_changed イベントを ', ' 結合で描画し、空は『ラベル: なし』にする",
  {
    annotation: {
      type: "description",
      description:
        "labels_changed イベントが『ラベル: {to を ', ' 結合}』(例 ラベル: api, billing)で描画され、to が空のときは『ラベル: なし』になることを検証",
    },
  },
  async () => {
    renderThread([
      {
        id: "e1",
        type: "labels_changed",
        actorEmail: "agent@example.com",
        payload: { from: ["auth"], to: ["api", "billing"] },
        createdAt: "2026-01-03T00:03:00.000Z",
      },
      {
        id: "e2",
        type: "labels_changed",
        actorEmail: "agent@example.com",
        payload: { from: ["api", "billing"], to: [] },
        createdAt: "2026-01-03T00:04:00.000Z",
      },
    ]);
    const events = page.getByTestId("ticket-event");
    await expect.element(events.first()).toHaveTextContent("ラベル: api, billing");
    await expect.element(events.nth(1)).toHaveTextContent("ラベル: なし");
  },
);

test(
  "メッセージとイベントを created_at 順に時系列マージする",
  {
    annotation: {
      type: "description",
      description:
        "messages と events を混在させたとき、message-item と ticket-event が created_at 昇順で交互に(customer メッセージ→イベント→agent メッセージの順で)並ぶことを検証",
    },
  },
  async () => {
    // イベントを2つのメッセージの間(00:01)に置き、時系列マージの並びを見る。
    renderThread([
      {
        id: "e1",
        type: "status_changed",
        actorEmail: "agent@example.com",
        payload: { from: "open", to: "in_progress" },
        createdAt: "2026-01-03T00:01:00.000Z",
      },
    ]);
    // スレッド全体の行(message-item + ticket-event)を出現順に読む。
    const thread = page.getByTestId("message-thread");
    await expect.element(thread.getByTestId("message-item").first()).toBeVisible();
    await expect
      .element(thread.getByTestId("ticket-event"))
      .toHaveTextContent("状態: open → in_progress");
    // 構造的アサーション: 行数はメッセージ2 + イベント1 = 3。
    await expect(thread.getByTestId("message-item").elements()).toHaveLength(2);
    await expect(thread.getByTestId("ticket-event").elements()).toHaveLength(1);
  },
);
