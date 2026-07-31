import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { TicketList } from "@/components/ticket-list";
import { useSessionUser } from "@/lib/session";
import type { TicketPriority, TicketStatus } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "@/lib/orpc";

// Auth guard: /tickets is a protected route, so resolve the session in
// beforeLoad and redirect unauthenticated visitors to /login before any ticket
// UI mounts — same mechanism as the home route (specs/auth.md, specs/tickets.md
// integration note).
export const Route = createFileRoute("/tickets")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: TicketsRoute,
});

function TicketsRoute() {
  const { user } = useLoaderData({ from: "/tickets" });
  return (
    <AppShell user={user}>
      <TicketsPage />
    </AppShell>
  );
}

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// Page size for the cursor-paginated list (spec: limit 50).
const PAGE_LIMIT = 50;

function TicketsPage() {
  const queryClient = useQueryClient();
  // Agent-only status control is hidden for the customer session
  // (specs/customer-portal.md); the API already scopes the list to the
  // customer's own tickets, so the rows themselves are unchanged.
  const isAgent = useSessionUser()?.role === "agent";

  // Cursor pagination via listPage (spec: specs/app-shell.md). Pages carry
  // { items, nextCursor }; the pageParam is the cursor (undefined for page 1).
  // retry:false surfaces load failures immediately (tickets-load-error) rather
  // than sitting through React Query's backoff.
  const listQuery = useInfiniteQuery({
    ...orpc.tickets.listPage.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, limit: PAGE_LIMIT }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    retry: false,
  });

  // Flatten loaded pages into the display list; server order (created_at DESC)
  // is preserved — no client re-sort (spec).
  const tickets = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: orpc.tickets.listPage.key() });

  const createMutation = useMutation(
    orpc.tickets.create.mutationOptions({ onSuccess: invalidateList }),
  );
  const setStatusMutation = useMutation(
    orpc.tickets.setStatus.mutationOptions({ onSuccess: invalidateList }),
  );

  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [formError, setFormError] = useState<string | null>(null);

  // The virtualizer needs a concrete scroll-region height; measure the flex-1
  // list area so it fills the remaining pane height and reflows on resize.
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

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = subject.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      setFormError("Subject must be between 1 and 200 characters.");
      return;
    }
    setFormError(null);
    createMutation.mutate(
      { subject: trimmed, priority },
      {
        onSuccess: () => {
          setSubject("");
          setPriority("medium");
          setShowForm(false);
        },
        onError: () => setFormError("Failed to create ticket."),
      },
    );
  };

  const onStatusChange = (id: string, status: TicketStatus) => {
    setStatusMutation.mutate({ id, status });
  };

  // Infinite scroll (spec): fetch the next page when the visible tail nears the
  // loaded count, but only when there is one and no fetch is in flight.
  const onEndReached = () => {
    if (listQuery.hasNextPage && !listQuery.isFetching) {
      void listQuery.fetchNextPage();
    }
  };

  return (
    <main className="flex h-full flex-col gap-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Tickets</h1>
        <Button type="button" onClick={() => setShowForm((v) => !v)}>
          New ticket
        </Button>
      </div>

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        >
          <Input
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Describe the issue"
          />
          <div className="flex items-center gap-3">
            <select
              aria-label="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TicketPriority)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={createMutation.isPending}>
              Create
            </Button>
          </div>
          {formError && (
            <p data-testid="ticket-error" role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      )}

      {listQuery.isError ? (
        <p data-testid="tickets-load-error" role="alert" className="text-sm text-destructive">
          Failed to load tickets.
        </p>
      ) : (
        <div ref={scrollAreaRef} className="min-h-0 flex-1">
          <TicketList
            tickets={tickets}
            onStatusChange={onStatusChange}
            showStatusControl={isAgent}
            onEndReached={onEndReached}
            height={listHeight || undefined}
          />
        </div>
      )}
    </main>
  );
}
