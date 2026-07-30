import { useRouteContext } from "@tanstack/react-router";
import type { User } from "@/auth/api";

// The current session user (email/role), resolved once by the route guard
// (beforeLoad in the protected routes) and shared through Router context. Pages
// under a guarded route read it here instead of re-fetching /api/auth/me, so the
// role-adapted UI (customer vs agent) stays in sync with the guard's decision.
//
// strict:false reads the nearest match's merged context without binding to a
// specific route id; `user` is present because every guarded route returns it
// from beforeLoad. Outside a guarded subtree it is undefined.
export function useSessionUser(): User | undefined {
  return useRouteContext({ strict: false, select: (context) => context.user as User | undefined });
}
