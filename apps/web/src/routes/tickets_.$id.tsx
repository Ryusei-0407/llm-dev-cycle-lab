import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { DraftPanel } from "@/components/draft-panel";
import { MessageThread } from "@/components/message-thread";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";
import type { Label } from "@/lib/tickets";

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
  // Generate draft is an agent-only tool (specs/customer-portal.md, and the
  // draft route is 403 for customers per specs/authz.md). Gate on role rather
  // than relying on the panel happening to be absent.
  const isAgent = useSessionUser()?.role === "agent";

  const detailQuery = useQuery({
    ...orpc.tickets.get.queryOptions({ input: { id } }),
    retry: false,
  });

  const invalidateDetail = () =>
    queryClient.invalidateQueries({ queryKey: orpc.tickets.get.queryKey({ input: { id } }) });

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
    <main className="flex h-full max-w-3xl flex-col gap-4 overflow-auto p-4">
      {ticket && (
        <div className="flex items-center gap-3">
          <span data-testid="ticket-number" className="text-sm text-ink-subtle tabular-nums">
            SUP-{ticket.number}
          </span>
          <h1 data-testid="ticket-subject" className="flex-1 text-xl font-semibold tracking-tight">
            {ticket.subject}
          </h1>
          {/* 付与中ラベルの閲覧はロール不問(編集トグルは agent のみ)。 */}
          <span data-testid="ticket-labels" className="flex items-center gap-1">
            {(ticket.labels ?? []).map((label) => (
              <span
                key={label.name}
                data-testid="ticket-label"
                className="rounded px-1.5 py-0.5 text-xs font-medium text-white"
                style={{ backgroundColor: label.color }}
              >
                {label.name}
              </span>
            ))}
          </span>
          <StatusBadge status={ticket.status} />
        </div>
      )}

      {ticket && isAgent && (
        <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface-1 p-4">
          <div className="flex items-center gap-3">
            <StatusControl ticketId={id} status={ticket.status} />
            <AssigneeControl ticketId={id} assigneeEmail={ticket.assigneeEmail ?? null} />
          </div>
          <LabelControl ticketId={id} labels={ticket.labels ?? []} />
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
    </main>
  );
}

// Agent-only status control on the detail page. Mirrors the list-row select
// (same testid/options) so a status change can be made where the event thread
// shows its history; the detail re-fetch pulls the new status_changed event.
function StatusControl({
  ticketId,
  status,
}: {
  ticketId: string;
  status: "open" | "in_progress" | "resolved";
}) {
  const queryClient = useQueryClient();
  const setStatus = useMutation(
    orpc.tickets.setStatus.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpc.tickets.get.queryKey({ input: { id: ticketId } }),
        }),
    }),
  );
  return (
    <select
      data-testid="ticket-status-select"
      aria-label="Status"
      value={status}
      onChange={(e) => setStatus.mutate({ id: ticketId, status: e.target.value as typeof status })}
      className="h-8 w-44 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <option value="open">Open</option>
      <option value="in_progress">In progress</option>
      <option value="resolved">Resolved</option>
    </select>
  );
}

// Agent-only assignee control (spec: specs/ticket-model.md 詳細). The options are
// 未割り当て (value "") plus the agents directory; changing the selection sends
// setAssignee ("" → null) and re-fetches the detail to reflect the new event +
// assignee. Only mounted for agents, so tickets.agents (agent-only) is safe.
function AssigneeControl({
  ticketId,
  assigneeEmail,
}: {
  ticketId: string;
  assigneeEmail: string | null;
}) {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({ ...orpc.tickets.agents.queryOptions(), retry: false });
  const setAssignee = useMutation(
    orpc.tickets.setAssignee.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpc.tickets.get.queryKey({ input: { id: ticketId } }),
        }),
    }),
  );
  const agents = agentsQuery.data ?? [];
  return (
    <select
      data-testid="assignee-select"
      aria-label="Assignee"
      value={assigneeEmail ?? ""}
      onChange={(e) => setAssignee.mutate({ id: ticketId, assigneeEmail: e.target.value || null })}
      className="h-8 w-44 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <option value="">未割り当て</option>
      {agents.map((agent) => (
        <option key={agent.email} value={agent.email}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

// Agent-only label editor (spec: specs/ticket-model.md 詳細). Every catalogue
// label renders as a toggle reflecting current assignment; clicking flips it and
// sends the full resulting name set via setLabels (server does the全置換).
function LabelControl({ ticketId, labels }: { ticketId: string; labels: Label[] }) {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ ...orpc.tickets.labels.queryOptions(), retry: false });
  const setLabels = useMutation(
    orpc.tickets.setLabels.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpc.tickets.get.queryKey({ input: { id: ticketId } }),
        }),
    }),
  );
  const catalog = catalogQuery.data ?? [];
  const active = new Set(labels.map((l) => l.name));
  const toggle = (name: string) => {
    const next = new Set(active);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setLabels.mutate({ id: ticketId, labels: [...next] });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {catalog.map((label) => {
        const on = active.has(label.name);
        return (
          <button
            key={label.name}
            type="button"
            data-testid={`label-toggle-${label.name}`}
            aria-pressed={on}
            onClick={() => toggle(label.name)}
            className="rounded px-2 py-0.5 text-xs font-medium transition-opacity"
            style={{
              backgroundColor: label.color,
              color: "#fff",
              opacity: on ? 1 : 0.35,
            }}
          >
            {label.name}
          </button>
        );
      })}
    </div>
  );
}
