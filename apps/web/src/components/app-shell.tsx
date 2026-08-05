import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

  // saved-views (spec: specs/saved-views.md): the agent's own saved filter combos,
  // listed under the two presets. Agent-only, same enabled guard as inboxCount so
  // a customer never calls the agent-only procedure. Delete removes the view and
  // invalidates the list (which /tickets also writes on create).
  const queryClient = useQueryClient();
  const viewsQuery = useQuery({
    ...orpc.tickets.viewsList.queryOptions(),
    enabled: isAgent,
    retry: false,
  });
  const savedViews = viewsQuery.data ?? [];
  const deleteViewMutation = useMutation(
    orpc.tickets.viewsDelete.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tickets.viewsList.key() }),
    }),
  );

  const onSignOut = async () => {
    await logout();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };

  const onRegisterPasskey = async () => {
    setPasskeyState((await registerPasskey()) ? "registered" : "error");
  };

  // Nav row shape shared by every sidebar link (spec: モック01). Icons are inline
  // and aria-hidden so they never leak into the accessible name the e2e aria
  // snapshots pin (受信トレイ / Tickets / Board). active lifts to surface-2.
  const navItemClass =
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-surface-2 [&.active]:text-foreground";

  return (
    <div className="flex h-dvh">
      <nav
        data-testid="app-sidebar"
        className="flex w-60 flex-col gap-0.5 border-r border-border px-2 py-3"
      >
        <div className="mb-2 flex items-center gap-2 px-2 py-1.5 text-sm font-semibold">
          <span
            aria-hidden="true"
            className="grid size-[18px] place-items-center rounded-[5px] bg-[var(--brand)] text-[10px] font-bold text-white"
          >
            S
          </span>
          サポートデスク
        </div>
        {/* Palette opener directly under the workspace name (spec: モック01). Shows
            the same ⌘K hint the shortcut uses; clicking it toggles the palette. */}
        <button
          type="button"
          data-testid="sidebar-search"
          onClick={() => setPaletteOpen(true)}
          className="mb-2 flex items-center justify-between rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          検索…
          <kbd className="rounded border border-input bg-surface-3 px-1.5 text-xs">⌘K</kbd>
        </button>
        {/* Inbox is agent-only (specs/triage.md); a customer never sees the link
            and is turned away at /inbox by inbox-forbidden — same出し分け as the
            board. The count badge is hidden while the inbox is empty. */}
        {isAgent && (
          <Link data-testid="nav-inbox" to="/inbox" className={navItemClass}>
            <InboxIcon />
            受信トレイ
            {inboxCount > 0 && (
              <span
                data-testid="inbox-count"
                className="ml-auto rounded-full bg-[var(--brand)] px-1.5 text-xs font-semibold tabular-nums text-white"
              >
                {inboxCount}
              </span>
            )}
          </Link>
        )}
        <Link data-testid="nav-tickets" to="/tickets" className={navItemClass}>
          <ListIcon />
          Tickets
        </Link>
        {/* The board is an agent-only view (specs/kanban.md); a customer never
            sees the link and is turned away at /board by board-forbidden. */}
        {user.role === "agent" && (
          <Link data-testid="nav-board" to="/board" className={navItemClass}>
            <BoardIcon />
            Board
          </Link>
        )}
        {/* Insights is agent-only (specs/insights.md), same出し分け as the board;
            a customer is turned away at /insights by insights-forbidden. */}
        {isAgent && (
          <Link data-testid="nav-insights" to="/insights" className={navItemClass}>
            <ChartIcon />
            インサイト
          </Link>
        )}
        {/* View presets (spec: モック01 ビュー節): plain Links that ride the
            existing /tickets URL filters — no new state, just a starting query. */}
        {isAgent && (
          <>
            <div className="px-2 pt-3.5 pb-1 text-[11px] tracking-wide text-ink-tertiary">
              ビュー
            </div>
            <Link
              data-testid="sidebar-view-high"
              to="/tickets"
              search={{ priority: "high" }}
              className={navItemClass}
            >
              <span aria-hidden="true" className="size-[7px] rounded-full bg-high" />
              高優先度
            </Link>
            <Link
              data-testid="sidebar-view-open"
              to="/tickets"
              search={{ status: "open" }}
              className={navItemClass}
            >
              <span aria-hidden="true" className="size-[7px] rounded-full bg-warn" />
              未対応のみ
            </Link>
            {/* The agent's saved views (spec: saved-views), directly under the two
                presets. Each is a Link carrying only the filter keys it stored,
                plus an inline delete that removes it immediately (no confirm). */}
            {savedViews.map((view) => (
              <div key={view.id} className={`${navItemClass} group`}>
                <Link
                  data-testid="sidebar-user-view"
                  to="/tickets"
                  search={view.filters}
                  className="flex flex-1 items-center gap-2"
                >
                  <span aria-hidden="true" className="size-[7px] rounded-full bg-[var(--brand)]" />
                  {view.name}
                </Link>
                <button
                  type="button"
                  data-testid="sidebar-user-view-delete"
                  aria-label={`Delete view ${view.name}`}
                  onClick={() => deleteViewMutation.mutate({ id: view.id })}
                  className="ml-auto text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <DeleteIcon />
                </button>
              </div>
            ))}
          </>
        )}
        <div className="mt-auto flex flex-col gap-2 px-1 pt-2">
          {/* copilot launcher (spec: specs/copilot.md), agent-only — directly
              above current-user. Ctrl/⌘+/ toggles the same panel. */}
          {isAgent && (
            <button
              type="button"
              data-testid="copilot-launch"
              onClick={() => setCopilotOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-border bg-gradient-to-b from-[var(--surface-2)] to-[var(--surface-1)] px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span aria-hidden="true" className="size-2 rounded-full bg-[var(--brand-hover)]" />
              Copilot に質問…
              <kbd className="ml-auto rounded border border-input bg-surface-3 px-1.5 text-xs">
                ⌘/
              </kbd>
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

// Nav glyphs traced from モック01 (inbox waveform / list / board bars / chart).
// aria-hidden via the shared props so the accessible name stays the link text.
const iconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  "aria-hidden": true,
  className: "shrink-0",
} as const;

function InboxIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2 8h3l1.5 3 3-6L11 8h3" />
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="3" width="3.4" height="10" rx="1" />
      <rect x="6.3" y="3" width="3.4" height="7" rx="1" />
      <rect x="10.6" y="3" width="3.4" height="4.5" rx="1" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 13V8.5m5 4.5V5.5m5 7.5V3" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg {...iconProps} width={12} height={12}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
