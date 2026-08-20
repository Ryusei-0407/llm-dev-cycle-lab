import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { DraftPanel } from "@/components/draft-panel";
import { MessageThread } from "@/components/message-thread";
import { TicketProperties } from "@/components/ticket-properties";
import { Button } from "@/components/ui/button";
import { isEditableTarget } from "@/lib/list-keys";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";
import type { TicketPriority, TicketStatus } from "@/lib/tickets";

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Esc で一覧へ戻る (spec: specs/keyboard-nav.md)。修飾なし単键のみ。入力系
  // フォーカス中・パレット表示中は何もしない(一覧側と同じガード。パレットの Escape
  // ハンドリングを奪わないため、開いている間だけ DOM に出る popup で検出する)。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('[data-testid="command-palette"]')) return;
      void navigate({ to: "/tickets" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
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
  const setPriority = useMutation(
    orpc.tickets.setPriority.mutationOptions({ onSuccess: invalidateDetail }),
  );
  const setAssignee = useMutation(
    orpc.tickets.setAssignee.mutationOptions({ onSuccess: invalidateDetail }),
  );
  const setLabels = useMutation(
    orpc.tickets.setLabels.mutationOptions({ onSuccess: invalidateDetail }),
  );

  const replyMutation = useMutation(
    orpc.tickets.reply.mutationOptions({
      onSuccess: invalidateDetail,
      // 既定の networkMode('online') はオフライン中の mutate を paused にする:
      // エラーも送信中表示も出ないまま、タブを閉じると返信がサイレント消失する。
      // 'always' なら fetch が即失敗して onError(reply-error + 入力保持)に落ち、
      // ユーザーは失敗を知って再送できる(サポート返信は自動再送より明示失敗)。
      networkMode: "always",
    }),
  );

  const [body, setBody] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  // isPending の pending 遷移は再レンダ経由で、同一タスク内の同期二連 dispatch
  // (transport リトライ等でも起こる形)を止められない。同期 ref が唯一の防波堤。
  const replyInFlight = useRef(false);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (replyInFlight.current) return;
    const trimmed = body.trim();
    // Client-side guard on the empty reply: keep the thread untouched and show
    // the error without a server round trip (server still enforces min(1)).
    if (trimmed.length < 1) {
      setReplyError("Reply cannot be empty.");
      return;
    }
    setReplyError(null);
    replyInFlight.current = true;
    // 送信時点の生テキストを控える: 送信中に打たれた「次の文」を成功時の
    // クリアで巻き添えにしない(変わっていないときだけ空にする)。
    const submitted = body;
    replyMutation.mutate(
      { ticketId: id, body: trimmed },
      {
        onSuccess: () => setBody((current) => (current === submitted ? "" : current)),
        onError: () => setReplyError("Failed to send reply."),
        onSettled: () => {
          replyInFlight.current = false;
        },
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
            className="flex flex-col gap-3 rounded-lg border border-(--hairline-strong) bg-surface-1 p-4"
          >
            <textarea
              aria-label="Reply"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Write a reply…"
              className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-ink-tertiary outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
          onPriorityChange={(priority: TicketPriority) => setPriority.mutate({ id, priority })}
          onAssigneeChange={(assigneeEmail) => setAssignee.mutate({ id, assigneeEmail })}
          onLabelsChange={(labels) => setLabels.mutate({ id, labels })}
        />
      )}
    </div>
  );
}
