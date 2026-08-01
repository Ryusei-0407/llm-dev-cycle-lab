import { MessageThread } from "./message-thread";

// VRT カタログストーリー: 全幅統一行(顧客/担当者)+ 差し込まれたイベント行を1枚で。
export const VisualCatalog = () => (
  <div className="max-w-3xl bg-background p-6">
    <MessageThread
      messages={[
        {
          id: "m1",
          ticketId: "t1",
          authorEmail: "customer@example.com",
          authorRole: "customer",
          body: "The reset link says 'token expired' right after it arrives.",
          createdAt: "2026-07-01T09:00:00.000Z",
        },
        {
          id: "m2",
          ticketId: "t1",
          authorEmail: "aki@example.com",
          authorRole: "agent",
          body: "Thanks for the report — a fix is rolling out within the hour.",
          createdAt: "2026-07-01T09:10:00.000Z",
        },
      ]}
      events={[
        {
          id: "e1",
          type: "status_changed",
          actorEmail: "aki@example.com",
          payload: { from: "open", to: "in_progress" },
          createdAt: "2026-07-01T09:05:00.000Z",
        },
      ]}
    />
  </div>
);
