import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { logout, type User } from "./api";

// Signed-in shell header (top-nav) per specs/auth.md: shows the current user
// and a Sign out control. Sign out clears the session then sends the user back
// to /login; router.invalidate re-runs the guard so no stale state lingers.
export function TopNav({ user }: { user: User }) {
  const router = useRouter();

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
        {/* The board is an agent-only view (specs/kanban.md); a customer never
            sees the link and is turned away at /board by board-forbidden. */}
        {user.role === "agent" && (
          <Link
            data-testid="nav-board"
            to="/board"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
          >
            Board
          </Link>
        )}
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
