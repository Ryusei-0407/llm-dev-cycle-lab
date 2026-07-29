import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { fetchMe } from "@/auth/api";
import { TopNav } from "@/auth/TopNav";
import { TicketList } from "@/components/ticket-list";
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
    <div className="flex min-h-dvh flex-col">
      <TopNav user={user} />
      <TicketsPage />
    </div>
  );
}

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function TicketsPage() {
  const queryClient = useQueryClient();

  // Surface load failures immediately (data-testid="tickets-load-error") instead
  // of sitting through React Query's default retry/backoff.
  const ticketsQuery = useQuery({ ...orpc.tickets.list.queryOptions(), retry: false });

  const createMutation = useMutation(
    orpc.tickets.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tickets.list.queryKey() }),
    }),
  );
  const setStatusMutation = useMutation(
    orpc.tickets.setStatus.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tickets.list.queryKey() }),
    }),
  );

  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [formError, setFormError] = useState<string | null>(null);

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

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-4">
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

      {ticketsQuery.isError ? (
        <p data-testid="tickets-load-error" role="alert" className="text-sm text-destructive">
          Failed to load tickets.
        </p>
      ) : (
        <TicketList tickets={ticketsQuery.data ?? []} onStatusChange={onStatusChange} />
      )}
    </main>
  );
}
