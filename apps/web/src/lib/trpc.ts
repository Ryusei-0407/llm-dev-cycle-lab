import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@app/api/tickets/router";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

// Same-origin: the Vite dev server proxies /api to the API port.
export const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc" })],
});
