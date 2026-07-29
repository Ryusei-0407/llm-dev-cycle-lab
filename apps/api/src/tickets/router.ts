import { initTRPC, TRPCError } from "@trpc/server";
import { createInput, setStatusInput } from "./schema.js";
import { ticketStore } from "./store.js";

const t = initTRPC.create();

export const ticketsRouter = t.router({
  list: t.procedure.query(() => ticketStore.list()),

  create: t.procedure.input(createInput).mutation(({ input }) => ticketStore.create(input)),

  setStatus: t.procedure.input(setStatusInput).mutation(({ input }) => {
    try {
      return ticketStore.setStatus(input);
    } catch {
      throw new TRPCError({ code: "NOT_FOUND", message: "ticket not found" });
    }
  }),
});

export const appRouter = t.router({
  tickets: ticketsRouter,
});

export type AppRouter = typeof appRouter;
