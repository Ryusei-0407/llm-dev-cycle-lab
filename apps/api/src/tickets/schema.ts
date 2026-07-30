import { z } from "zod";

export const statusSchema = z.enum(["open", "in_progress", "resolved"]);
export const prioritySchema = z.enum(["low", "medium", "high"]);

export const createInput = z.object({
  subject: z.string().min(1).max(200),
  priority: prioritySchema,
});

export const setStatusInput = z.object({
  id: z.string(),
  status: statusSchema,
});

// ticket-detail (spec: specs/ticket-detail.md サーバー契約). get takes a ticket
// id; reply takes the target ticket + the message body (author is session-
// derived, never part of the input).
export const getInput = z.object({
  id: z.string().uuid(),
});

export const replyInput = z.object({
  ticketId: z.string().uuid(),
  body: z.string().min(1).max(2000),
});

export type CreateInput = z.infer<typeof createInput>;
export type SetStatusInput = z.infer<typeof setStatusInput>;
export type GetInput = z.infer<typeof getInput>;
export type ReplyInput = z.infer<typeof replyInput>;
