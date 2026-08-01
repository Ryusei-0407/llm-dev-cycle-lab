import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { User } from "@/auth/api";
import { logout, registerPasskey } from "@/auth/api";
import { Button } from "@/components/ui/button";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { supportsPasskeys } from "@/lib/webauthn";

// Signed-in app shell (spec: specs/app-shell.md): a fixed left sidebar plus a
// full-width main pane. It replaces TopNav as the wrapper for every
// authenticated route, so this is where the realtime socket (spec:
// specs/ws-realtime.md) lives — the /api/ws connection lasts exactly as long as
// the signed-in shell. Sign out clears the session then sends the user back to
// /login; router.invalidate re-runs the guard so no stale state lingers.
export function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const router = useRouter();
  useRealtimeInvalidation();
  const [passkeyState, setPasskeyState] = useState<"idle" | "registered" | "error">("idle");

  const onSignOut = async () => {
    await logout();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };

  const onRegisterPasskey = async () => {
    setPasskeyState((await registerPasskey()) ? "registered" : "error");
  };

  return (
    <div className="flex h-dvh">
      <nav
        data-testid="app-sidebar"
        className="flex w-60 flex-col gap-1 border-r border-border px-3 py-4"
      >
        <span className="mb-4 px-2 text-sm font-semibold tracking-tight">サポートデスク</span>
        <Link
          data-testid="nav-tickets"
          to="/tickets"
          className="rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-surface-1 [&.active]:text-foreground"
        >
          Tickets
        </Link>
        {/* The board is an agent-only view (specs/kanban.md); a customer never
            sees the link and is turned away at /board by board-forbidden. */}
        {user.role === "agent" && (
          <Link
            data-testid="nav-board"
            to="/board"
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-surface-1 [&.active]:text-foreground"
          >
            Board
          </Link>
        )}
        <div className="mt-auto flex flex-col gap-2 px-2">
          <span data-testid="current-user" className="text-sm text-muted-foreground">
            {user.name}
          </span>
          {supportsPasskeys() &&
            (passkeyState === "registered" ? (
              <span data-testid="passkey-registered" className="text-sm text-muted-foreground">
                パスキーを登録しました
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                data-testid="passkey-register"
                onClick={onRegisterPasskey}
              >
                パスキーを登録
              </Button>
            ))}
          {passkeyState === "error" && (
            <span data-testid="passkey-error" className="text-sm text-destructive">
              登録に失敗しました
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </nav>
      <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
