import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { TicketList } from "@/components/ticket-list";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";

// Auth guard mirrors /board and /tickets: resolve the session in beforeLoad and
// redirect unauthenticated visitors before any inbox UI mounts (specs/auth.md).
export const Route = createFileRoute("/inbox")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: InboxRoute,
});

function InboxRoute() {
  const { user } = useLoaderData({ from: "/inbox" });
  return (
    <AppShell user={user}>
      <InboxPage />
    </AppShell>
  );
}

// The inbox reuses listPage with the triage predicate (spec: specs/triage.md):
// unassigned tickets that still need work. Both filters are server-side so the
// created_at DESC order and keyset pagination are unchanged.
const PAGE_LIMIT = 50;

function InboxPage() {
  // The inbox is agent-only (spec). A customer reaching /inbox directly lands on
  // the dedicated forbidden panel (board-forbidden と同型); the inboxCount /
  // listPage authz still holds regardless of this UI gate.
  const isAgent = useSessionUser()?.role === "agent";

  const listQuery = useInfiniteQuery({
    ...orpc.tickets.listPage.infiniteOptions({
      input: (cursor: string | undefined) => ({
        cursor,
        limit: PAGE_LIMIT,
        unassigned: true,
        unresolved: true,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    retry: false,
    enabled: isAgent,
  });

  const tickets = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState<number>(0);
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setListHeight(el.clientHeight));
    observer.observe(el);
    setListHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const onEndReached = () => {
    if (listQuery.hasNextPage && !listQuery.isFetching) {
      void listQuery.fetchNextPage();
    }
  };

  if (!isAgent) {
    return (
      <main className="flex h-full flex-col gap-4 overflow-auto p-4">
        <p
          data-testid="inbox-forbidden"
          role="alert"
          className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
        >
          The inbox is available to agents only.
        </p>
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col gap-4 px-6 py-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">受信トレイ</h1>
        <p className="text-sm text-ink-subtle">未割り当てのチケット</p>
      </div>

      {listQuery.isError ? (
        <p data-testid="tickets-load-error" role="alert" className="text-sm text-destructive">
          Failed to load tickets.
        </p>
      ) : tickets.length === 0 && !listQuery.isPending ? (
        <p data-testid="inbox-empty" className="text-sm text-ink-subtle">
          受信トレイは空です
        </p>
      ) : (
        <div ref={scrollAreaRef} className="min-h-0 flex-1">
          <TicketList
            tickets={tickets}
            // Triage happens in the detail panel's assignee-select (spec); the
            // inbox has no inline status control, so this handler is unused.
            onStatusChange={() => {}}
            showStatusControl={false}
            onEndReached={onEndReached}
            height={listHeight || undefined}
          />
        </div>
      )}
    </main>
  );
}
