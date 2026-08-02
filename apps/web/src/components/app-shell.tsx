import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { User } from "@/auth/api";
import { logout, registerPasskey } from "@/auth/api";
import { CommandPalette } from "@/components/command-palette";
import { CopilotPanel } from "@/components/copilot-panel";
import { Button } from "@/components/ui/button";
import { setCopilotOpen, toggleCopilotOpen, useCopilotOpen } from "@/lib/copilot-open";
import { orpc } from "@/lib/orpc";
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

  // Global ⌘K / Ctrl+K opens the command palette from any authenticated screen
  // (spec: specs/command-palette.md). The shortcut and open state live here so a
  // single palette is mounted per shell; preventDefault suppresses the browser's
  // own find bar. It fires even while an input is focused (spec).
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Inbox badge count (spec: specs/triage.md). Agent-only: the enabled guard
  // stops a customer session from ever calling the agent-only procedure (which
  // would 403), mirroring the detail panel's agents/labels fetch. WS
  // ticket.created/updated invalidate this key alongside the lists
  // (lib/realtime.ts), so the badge tracks the inbox without a manual refetch.
  const isAgent = user.role === "agent";

  // copilot (spec: specs/copilot.md): a docked chat, agent-only. The open state
  // lives in a module store (lib/copilot-open) rather than useState so the panel
  // survives a route change — each protected route mounts its own AppShell, so
  // per-shell state would reset when a SUP-n reference jumps to a ticket. The
  // Ctrl/⌘+/ toggle and the launcher are both gated on isAgent — a customer never
  // sees the launcher and the key is inert.
  const copilotOpen = useCopilotOpen();
  useEffect(() => {
    if (!isAgent) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggleCopilotOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAgent]);
  const inboxCountQuery = useQuery({
    ...orpc.tickets.inboxCount.queryOptions(),
    enabled: isAgent,
    retry: false,
  });
  const inboxCount = inboxCountQuery.data ?? 0;

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
        <span className="mb-2 px-2 text-sm font-semibold tracking-tight">サポートデスク</span>
        {/* Palette opener directly under the workspace name (spec: モック01). Shows
            the same ⌘K hint the shortcut uses; clicking it toggles the palette. */}
        <button
          type="button"
          data-testid="sidebar-search"
          onClick={() => setPaletteOpen(true)}
          className="mb-2 flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          検索…
          <kbd className="rounded bg-surface-2 px-1.5 text-xs text-foreground">⌘K</kbd>
        </button>
        {/* Inbox is agent-only (specs/triage.md); a customer never sees the link
            and is turned away at /inbox by inbox-forbidden — same出し分け as the
            board. The count badge is hidden while the inbox is empty. */}
        {isAgent && (
          <Link
            data-testid="nav-inbox"
            to="/inbox"
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-surface-1 [&.active]:text-foreground"
          >
            受信トレイ
            {inboxCount > 0 && (
              <span
                data-testid="inbox-count"
                className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums text-foreground"
              >
                {inboxCount}
              </span>
            )}
          </Link>
        )}
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
        {/* Insights is agent-only (specs/insights.md), same出し分け as the board;
            a customer is turned away at /insights by insights-forbidden. */}
        {isAgent && (
          <Link
            data-testid="nav-insights"
            to="/insights"
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-surface-1 [&.active]:text-foreground"
          >
            インサイト
          </Link>
        )}
        <div className="mt-auto flex flex-col gap-2 px-2">
          {/* copilot launcher (spec: specs/copilot.md), agent-only — directly
              above current-user. Ctrl/⌘+/ toggles the same panel. */}
          {isAgent && (
            <button
              type="button"
              data-testid="copilot-launch"
              onClick={() => setCopilotOpen(true)}
              className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Copilot に質問…
              <kbd className="rounded bg-surface-2 px-1.5 text-xs text-foreground">⌘/</kbd>
            </button>
          )}
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
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAgent={isAgent} />
      {isAgent && copilotOpen && <CopilotPanel onClose={() => setCopilotOpen(false)} />}
    </div>
  );
}
