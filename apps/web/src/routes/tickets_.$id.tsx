import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { fetchMe } from "@/auth/api";
import { TopNav } from "@/auth/TopNav";
import { DraftPanel } from "@/components/draft-panel";
import { MessageThread } from "@/components/message-thread";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/orpc";

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
    <div className="flex min-h-dvh flex-col">
      <TopNav user={user} />
      <TicketDetailPage />
    </div>
  );
}

// A NOT_FOUND from tickets.get means the id doesn't resolve to a ticket — render
// the dedicated not-found panel rather than a generic error. Any other error
// (e.g. transport) is rare enough to fold into the same panel; the spec's only
// handled get failure is the missing ticket.
function isNotFound(error: unknown): boolean {
  // ORPCError overrides Symbol.hasInstance so instanceof holds across the
  // client's separate dependency graph. A non-oRPC error (rare) folds into the
  // same panel — the spec's only handled get failure is the missing ticket.
  return error instanceof ORPCError ? error.code === "NOT_FOUND" : true;
}

function TicketDetailPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    ...orpc.tickets.get.queryOptions({ input: { id } }),
    retry: false,
  });

  const replyMutation = useMutation(
    orpc.tickets.reply.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: orpc.tickets.get.queryKey({ input: { id } }) }),
    }),
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
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-4">
        {isNotFound(detailQuery.error) ? (
          <p
            data-testid="ticket-not-found"
            role="alert"
            className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
          >
            This ticket could not be found.
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            Failed to load ticket.
          </p>
        )}
      </main>
    );
  }

  const ticket = detailQuery.data?.ticket;
  const messages = detailQuery.data?.messages ?? [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-4">
      {ticket && (
        <div className="flex items-center gap-3">
          <h1 data-testid="ticket-subject" className="flex-1 text-xl font-semibold tracking-tight">
            {ticket.subject}
          </h1>
          <StatusBadge status={ticket.status} />
        </div>
      )}

      <MessageThread messages={messages} />

      <DraftPanel
        ticketId={id}
        onUseDraft={(text) => {
          // Use draft overwrites the current reply (spec: 既存入力は上書き) and
          // clears any stale empty-reply error.
          setBody(text);
          setReplyError(null);
        }}
      />

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
    </main>
  );
}
