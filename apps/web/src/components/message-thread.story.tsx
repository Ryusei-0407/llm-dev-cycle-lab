import { MessageThread } from "./message-thread";

// VRT カタログストーリー: 顧客/担当者の両ロールの吹き出しを1枚で。
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
    />
  </div>
);
