import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { fetchMe } from "@/auth/api";
import { TopNav } from "@/auth/TopNav";
import { KanbanBoard } from "@/components/kanban-board";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";
import type { TicketStatus } from "@/lib/tickets";

// Auth guard mirrors /tickets: resolve the session in beforeLoad and redirect
// unauthenticated visitors before any board UI mounts (specs/auth.md).
export const Route = createFileRoute("/board")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: BoardRoute,
});

function BoardRoute() {
  const { user } = useLoaderData({ from: "/board" });
  return (
    <div className="flex min-h-dvh flex-col">
      <TopNav user={user} />
      <BoardPage />
    </div>
  );
}

function BoardPage() {
  // The board is agent-only (spec). A customer reaching /board directly lands on
  // the dedicated forbidden panel (ticket-forbidden と同型) — the API list/setStatus
  // authz still holds regardless of this UI gate.
  const isAgent = useSessionUser()?.role === "agent";

  const queryClient = useQueryClient();
  const ticketsQuery = useQuery({
    ...orpc.tickets.list.queryOptions(),
    retry: false,
    enabled: isAgent,
  });
  const setStatusMutation = useMutation(
    orpc.tickets.setStatus.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tickets.list.queryKey() }),
    }),
  );

  if (!isAgent) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 p-4">
        <p
          data-testid="board-forbidden"
          role="alert"
          className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
        >
          The board is available to agents only.
        </p>
      </main>
    );
  }

  // mutateAsync so a rejected setStatus rejects the board's onSetStatus, which is
  // where the card's rollback / board-error lives (kanban-board.tsx).
  const onSetStatus = async (id: string, status: TicketStatus) => {
    await setStatusMutation.mutateAsync({ id, status });
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold tracking-tight">Board</h1>
      {ticketsQuery.isError ? (
        <p data-testid="board-error" role="alert" className="text-sm text-destructive">
          Failed to load tickets.
        </p>
      ) : (
        <KanbanBoard tickets={ticketsQuery.data ?? []} onSetStatus={onSetStatus} />
      )}
    </main>
  );
}
