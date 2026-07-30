import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { logout, type User } from "./api";

// Signed-in shell header (top-nav) per specs/auth.md: shows the current user
// and a Sign out control. Sign out clears the session then sends the user back
// to /login; router.invalidate re-runs the guard so no stale state lingers.
//
// This header is rendered by every authenticated route and nowhere else, so it
// is where the realtime socket (spec: specs/ws-realtime.md) is enabled — the
// /api/ws connection lives exactly as long as the signed-in shell.
export function TopNav({ user }: { user: User }) {
  const router = useRouter();
  useRealtimeInvalidation();

  const onSignOut = async () => {
    await logout();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };

  return (
    <header
      data-testid="top-nav"
      className="flex h-14 items-center justify-between border-b border-border px-4"
    >
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium tracking-tight">サポートデスク</span>
        <Link
          data-testid="nav-tickets"
          to="/tickets"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
        >
          Tickets
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <span data-testid="current-user" className="text-sm text-muted-foreground">
          {user.name}
        </span>
        <Button variant="secondary" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
