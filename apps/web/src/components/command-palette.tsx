import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useState } from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "@/lib/orpc";

// ⌘K command palette (spec: specs/command-palette.md). Navigation + ticket
// search from any authenticated screen. Open/close state and the global
// shortcut live in AppShell; this component is the dialog body. isAgent gates
// the agent-only destinations (受信トレイ / Board), matching the sidebar links.
type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAgent: boolean;
};

// Navigation targets. inbox/board are agent-only (specs/triage.md, specs/kanban.md);
// the same 出し分け the sidebar applies. Each carries its own testid.
type NavItem = { to: string; label: string; testid: string; agentOnly: boolean };
const NAV_ITEMS: NavItem[] = [
  { to: "/inbox", label: "受信トレイ", testid: "palette-nav-inbox", agentOnly: true },
  { to: "/tickets", label: "Tickets", testid: "palette-nav-tickets", agentOnly: false },
  { to: "/board", label: "Board", testid: "palette-nav-board", agentOnly: true },
];

export function CommandPalette({ open, onOpenChange, isAgent }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  // Ticket search (spec: query key on q, enabled only for a non-empty query,
  // retry:false so a failure surfaces without React Query's backoff). The
  // server already applies the role scope, so the rows are safe to render as-is.
  const searchQuery = useQuery({
    ...orpc.tickets.search.queryOptions({ input: { q: query } }),
    enabled: query.length > 0,
    retry: false,
  });
  const tickets = searchQuery.data ?? [];

  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to });
  };

  // shouldFilter=false のため cmdk はナビを絞り込まない。自前で検索語に
  // マッチしないナビを外す — さもないと cmdk の先頭選択が常にナビに残り、
  // 検索ヒットへ Enter で確定できない(「検索が効かない」体験になる)。
  const q = query.trim().toLowerCase();
  const navItems = NAV_ITEMS.filter(
    (item) => (!item.agentOnly || isAgent) && (q === "" || item.label.toLowerCase().includes(q)),
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          data-testid="command-palette"
          className="fixed top-1/3 left-1/2 z-50 w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-0 overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogTitle className="sr-only">コマンドパレット</DialogTitle>
          <DialogDescription className="sr-only">画面遷移とチケット検索</DialogDescription>
          {/* shouldFilter=false: navigation is filtered by our own agent 出し分け,
              and ticket rows are the server result rendered verbatim (spec: cmdk
              の組み込みフィルタはチケット行には適用しない). */}
          <Command shouldFilter={false} className="rounded-xl!">
            <CommandInput
              data-testid="palette-input"
              placeholder="検索またはコマンド…"
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            <CommandList>
              {navItems.length > 0 && (
                <CommandGroup heading="ナビゲーション">
                  {navItems.map((item) => (
                    <CommandItem
                      key={item.testid}
                      data-testid={item.testid}
                      value={item.testid}
                      onSelect={() => go(item.to)}
                    >
                      {item.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {query.length > 0 && (
                <CommandGroup heading="チケット">
                  {/* cmdk's Command.Empty only renders when the whole list has no
                      items, but navigation is always present, so render our own
                      empty row keyed on the (non-loading) zero-result state. */}
                  {tickets.length === 0
                    ? !searchQuery.isFetching && (
                        <div
                          data-testid="palette-empty"
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          該当なし
                        </div>
                      )
                    : tickets.map((ticket) => (
                        <CommandItem
                          key={ticket.id}
                          data-testid="palette-ticket"
                          value={ticket.id}
                          onSelect={() => go(`/tickets/${ticket.id}`)}
                        >
                          <span className="text-muted-foreground tabular-nums">
                            SUP-{ticket.number}
                          </span>
                          <span className="truncate">{ticket.subject}</span>
                        </CommandItem>
                      ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
