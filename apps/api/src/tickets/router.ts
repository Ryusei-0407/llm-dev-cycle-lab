import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { ticketStore } from "./store.js";

const t = initTRPC.create();

const statusSchema = z.enum(["open", "in_progress", "resolved"]);
const prioritySchema = z.enum(["low", "medium", "high"]);

export const createInput = z.object({
  subject: z.string().min(1).max(200),
  priority: prioritySchema,
});

export const setStatusInput = z.object({
  id: z.string(),
  status: statusSchema,
});

export const ticketsRouter = t.router({
  list: t.procedure.query(() => ticketStore.list()),

  create: t.procedure.input(createInput).mutation(({ input }) => ticketStore.create(input)),

  setStatus: t.procedure.input(setStatusInput).mutation(({ input }) => {
    const ticket = ticketStore.setStatus(input.id, input.status);
    if (!ticket) {
      throw new TRPCError({ code: "NOT_FOUND", message: "ticket not found" });
    }
    return ticket;
  }),
});

export const appRouter = t.router({
  tickets: ticketsRouter,
});

export type AppRouter = typeof appRouter;
