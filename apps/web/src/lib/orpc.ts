import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@app/api/tickets/router";

// Same-origin: the Vite dev server proxies /api to the API port. RPCLink needs
// an absolute URL, so derive it from the current origin at call time.
const link = new RPCLink({ url: `${window.location.origin}/api/rpc` });

const client: RouterClient<AppRouter> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
