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

export type CreateInput = z.infer<typeof createInput>;
export type SetStatusInput = z.infer<typeof setStatusInput>;
