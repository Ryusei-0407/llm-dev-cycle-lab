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

// set-priority (spec: specs/set-priority.md). A ticket id plus the target
// priority enum; both reject at this boundary (uuid 検証は get/setAssignee 系の
// 現行規約に合わせる — setStatus の素の string は旧規約)。
export const setPriorityInput = z.object({
  id: z.string().uuid(),
  priority: prioritySchema,
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

// ticket-model (spec: specs/ticket-model.md). setAssignee takes the ticket id
// plus the target agent email or null (unassign); the "is it an agent" check is
// a DB lookup done in the store, not zod. setLabels takes label names for a full
// replace (empty = clear all); duplicates are normalised in the store.
export const setAssigneeInput = z.object({
  id: z.string().uuid(),
  assigneeEmail: z.string().email().nullable(),
});

export const setLabelsInput = z.object({
  id: z.string().uuid(),
  labels: z.array(z.string()),
});

// listPage: opaque cursor + a 1..100 limit (default 50). The cursor's internal
// shape (base64url("createdAt|id")) is decoded in the store; a malformed token
// is a runtime BAD_REQUEST there, not a zod error. The filter fields are all
// optional and AND-combined in the store (spec: specs/triage.md); label is a
// free name (a name absent from the catalogue yields an empty page, not an
// error). unresolved shares inboxCount's predicate (status <> 'resolved').
export const listPageInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  label: z.string().optional(),
  unassigned: z.boolean().optional(),
  unresolved: z.boolean().optional(),
});

// command-palette search (spec: specs/command-palette.md). q is trimmed then
// bounded to 1..100 chars, so a whitespace-only query rejects as empty. The
// number-vs-subject decision lives in the store, not zod.
export const searchInput = z.object({
  q: z.string().trim().min(1).max(100),
});

export type CreateInput = z.infer<typeof createInput>;
export type SetStatusInput = z.infer<typeof setStatusInput>;
export type SetPriorityInput = z.infer<typeof setPriorityInput>;
export type GetInput = z.infer<typeof getInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type SetAssigneeInput = z.infer<typeof setAssigneeInput>;
export type SetLabelsInput = z.infer<typeof setLabelsInput>;
export type ListPageInput = z.infer<typeof listPageInput>;
export type SearchInput = z.infer<typeof searchInput>;
