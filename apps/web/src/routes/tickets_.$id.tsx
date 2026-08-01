import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { DraftPanel } from "@/components/draft-panel";
import { MessageThread } from "@/components/message-thread";
import { TicketProperties } from "@/components/ticket-properties";
import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";
import type { TicketStatus } from "@/lib/tickets";

// Auth guard mirrors /tickets: resolve the session in beforeLoad and redirect
// unauthenticated visitors before any detail UI mounts (specs/auth.md).
export const Route = createFileRoute("/tickets_/$id")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: TicketDetailRoute,
});

function TicketDetailRoute() {
  const { user } = Route.useLoaderData();
  return (
    <AppShell user={user}>
      <TicketDetailPage />
    </AppShell>
  );
}

// A FORBIDDEN from tickets.get means a customer reached someone else's ticket
// (specs/authz.md ownership check) — the dedicated forbidden panel, distinct
// from not-found. ORPCError overrides Symbol.hasInstance so instanceof holds
// across the client's separate dependency graph.
function isForbidden(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "FORBIDDEN";
}

function TicketDetailPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  // Generate draft and the property editors are agent-only (specs/customer-portal.md,
  // and the draft route is 403 for customers per specs/authz.md). Gate on role rather
  // than relying on controls happening to be absent.
  const isAgent = useSessionUser()?.role === "agent";

  const detailQuery = useQuery({
    ...orpc.tickets.get.queryOptions({ input: { id } }),
    retry: false,
  });

  const invalidateDetail = () =>
    queryClient.invalidateQueries({ queryKey: orpc.tickets.get.queryKey({ input: { id } }) });

  // Property catalogues are agent-only (tickets.agents is an agent API); customers
  // get a read-only panel, so skip the fetches entirely for them.
  const agentsQuery = useQuery({
    ...orpc.tickets.agents.queryOptions(),
    retry: false,
    enabled: isAgent,
  });
  const labelsQuery = useQuery({
    ...orpc.tickets.labels.queryOptions(),
    retry: false,
    enabled: isAgent,
  });

  const setStatus = useMutation(
    orpc.tickets.setStatus.mutationOptions({ onSuccess: invalidateDetail }),
  );
  const setAssignee = useMutation(
    orpc.tickets.setAssignee.mutationOptions({ onSuccess: invalidateDetail }),
  );
  const setLabels = useMutation(
    orpc.tickets.setLabels.mutationOptions({ onSuccess: invalidateDetail }),
  );

  const replyMutation = useMutation(
    orpc.tickets.reply.mutationOptions({ onSuccess: invalidateDetail }),
  );

  const [body, setBody] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    // Client-side guard on the empty reply: keep the thread untouched and show
    // the error without a server round trip (server still enforces min(1)).
    if (trimmed.length < 1) {
      setReplyError("Reply cannot be empty.");
      return;
    }
    setReplyError(null);
    replyMutation.mutate(
      { ticketId: id, body: trimmed },
      {
        onSuccess: () => setBody(""),
        onError: () => setReplyError("Failed to send reply."),
      },
    );
  };

  if (detailQuery.isError) {
    return (
      <main className="flex h-full max-w-3xl flex-col gap-4 overflow-auto p-4">
        {isForbidden(detailQuery.error) ? (
          <p
            data-testid="ticket-forbidden"
            role="alert"
            className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
          >
            You do not have access to this ticket.
          </p>
        ) : (
          <p
            data-testid="ticket-not-found"
            role="alert"
            className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
          >
            This ticket could not be found.
          </p>
        )}
      </main>
    );
  }

  const ticket = detailQuery.data?.ticket;
  const messages = detailQuery.data?.messages ?? [];
  const events = detailQuery.data?.events ?? [];

  return (
    <div className="flex h-full">
      {/* スレッド列: 自身がスクロールし、中身は max-w-3xl を左寄せ(mx-auto しない)。 */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="flex max-w-3xl flex-col gap-4 px-6 py-4">
          {ticket && (
            <div className="flex flex-col gap-1">
              <nav data-testid="ticket-breadcrumb" className="flex items-center gap-1 text-sm">
                <Link to="/tickets" className="text-ink-subtle hover:text-ink">
                  Tickets
                </Link>
                <span className="text-ink-tertiary">›</span>
                <span data-testid="ticket-number" className="text-ink-subtle tabular-nums">
                  SUP-{ticket.number}
                </span>
              </nav>
              <h1 data-testid="ticket-subject" className="text-xl font-semibold tracking-tight">
                {ticket.subject}
              </h1>
            </div>
          )}

          <MessageThread messages={messages} events={events} />

          {isAgent && (
            <DraftPanel
              ticketId={id}
              onUseDraft={(text) => {
                // Use draft overwrites the current reply (spec: 既存入力は上書き) and
                // clears any stale empty-reply error.
                setBody(text);
                setReplyError(null);
              }}
            />
          )}

          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface-1 p-4"
          >
            <textarea
              aria-label="Reply"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Write a reply…"
              className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {replyError && (
              <p data-testid="reply-error" role="alert" className="text-sm text-destructive">
                {replyError}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={replyMutation.isPending}>
                Send reply
              </Button>
            </div>
          </form>
        </div>
      </main>

      {ticket && (
        <TicketProperties
          ticket={ticket}
          role={isAgent ? "agent" : "customer"}
          agents={agentsQuery.data ?? []}
          labelCatalog={labelsQuery.data ?? []}
          onStatusChange={(status: TicketStatus) => setStatus.mutate({ id, status })}
          onAssigneeChange={(assigneeEmail) => setAssignee.mutate({ id, assigneeEmail })}
          onLabelsChange={(labels) => setLabels.mutate({ id, labels })}
        />
      )}
    </div>
  );
}
