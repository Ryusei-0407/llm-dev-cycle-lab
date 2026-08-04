import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { TicketList } from "@/components/ticket-list";
import { isEditableTarget, nextActiveIndex } from "@/lib/list-keys";
import { useSessionUser } from "@/lib/session";
import type { TicketPriority, TicketStatus } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "@/lib/orpc";

// Filter state lives in the URL search params (spec: specs/triage.md) so a
// filtered list is reload- and share-safe. Each field is optional; an unknown
// enum or a blank string drops to undefined so the URL never carries a filter
// the API would reject, and "no filter" is simply the absence of the key.
type TicketSearch = {
  status?: TicketStatus;
  priority?: TicketPriority;
  label?: string;
};

const STATUS_VALUES: TicketStatus[] = ["open", "in_progress", "resolved"];
const PRIORITY_VALUES: TicketPriority[] = ["low", "medium", "high"];

function validateSearch(search: Record<string, unknown>): TicketSearch {
  const status = search.status;
  const priority = search.priority;
  const label = search.label;
  return {
    status:
      typeof status === "string" && STATUS_VALUES.includes(status as TicketStatus)
        ? (status as TicketStatus)
        : undefined,
    priority:
      typeof priority === "string" && PRIORITY_VALUES.includes(priority as TicketPriority)
        ? (priority as TicketPriority)
        : undefined,
    label: typeof label === "string" && label.length > 0 ? label : undefined,
  };
}

// Auth guard: /tickets is a protected route, so resolve the session in
// beforeLoad and redirect unauthenticated visitors to /login before any ticket
// UI mounts — same mechanism as the home route (specs/auth.md, specs/tickets.md
// integration note).
export const Route = createFileRoute("/tickets")({
  validateSearch,
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

const STATUS_FILTER_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
];

// Page size for the cursor-paginated list (spec: limit 50).
const PAGE_LIMIT = 50;

// Shared style for the header filter selects; matches the New-ticket form's
// priority select so the two controls read as one control family.
const FILTER_SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function TicketsPage() {
  const queryClient = useQueryClient();
  // Agent-only status control is hidden for the customer session
  // (specs/customer-portal.md); the API already scopes the list to the
  // customer's own tickets, so the rows themselves are unchanged.
  const isAgent = useSessionUser()?.role === "agent";

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const hasFilter = !!(search.status || search.priority || search.label);

  // Merge one changed filter into the URL search params (spec: フィルタ値は URL
  // search params). An empty selection clears that key. TanStack Router's
  // validateSearch normalises the result, and because the infinite query keys on
  // these values the cursor is dropped and the list re-fetches from page 1.
  const setFilter = (patch: Partial<TicketSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  };

  // Label catalogue for the filter select (spec: tickets.labels). Fetched for
  // agents only: the repo keeps a customer session off tickets.labels/agents (the
  // detail panel gates the same way, and customer-portal/detail-panel E2E count
  // those requests). A customer still sees the filter-label control, with only
  // the "すべて" option.
  const labelsQuery = useQuery({
    ...orpc.tickets.labels.queryOptions(),
    enabled: isAgent,
    retry: false,
  });

  // Cursor pagination via listPage (spec: specs/app-shell.md). Pages carry
  // { items, nextCursor }; the pageParam is the cursor (undefined for page 1).
  // retry:false surfaces load failures immediately (tickets-load-error) rather
  // than sitting through React Query's backoff. The active filters are part of
  // the query input, so they key the cache — changing a filter drops the old
  // pages (and the cursor) and starts over from page 1 (spec).
  const listQuery = useInfiniteQuery({
    ...orpc.tickets.listPage.infiniteOptions({
      input: (cursor: string | undefined) => ({
        cursor,
        limit: PAGE_LIMIT,
        status: search.status,
        priority: search.priority,
        label: search.label,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    retry: false,
  });

  // Flatten loaded pages into the display list; server order (created_at DESC)
  // is preserved — no client re-sort (spec).
  const tickets = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  // Keyboard navigation (spec: specs/keyboard-nav.md). The active row index
  // lives here (route) and is handed to TicketList as a prop; null = 未選択.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Clamp the active index into the loaded range when the row set changes
  // (filter change / re-fetch). 行数が減って範囲外になったら末尾へ、0件なら未選択。
  const ticketCount = tickets.length;
  useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return null;
      if (ticketCount === 0) return null;
      return Math.min(current, ticketCount - 1);
    });
  }, [ticketCount]);

  // document keydown for list navigation (spec): j/↓ 次へ、k/↑ 前へ、Enter/o で
  // アクティブ行の詳細へ SPA 遷移。修飾キー付き・入力系フォーカス中・パレット表示中は
  // 何もしない(⌘K/⌘/ の既存ショートカットとは修飾なし単键で棲み分け)。パレットは
  // AppShell ローカル state なので、開いている間だけ DOM に出る popup で検出する。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('[data-testid="command-palette"]')) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((current) => nextActiveIndex(current, 1, tickets.length));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((current) => nextActiveIndex(current, -1, tickets.length));
      } else if (e.key === "Enter" || e.key === "o") {
        if (activeIndex === null) return;
        const ticket = tickets[activeIndex];
        if (!ticket) return;
        e.preventDefault();
        void navigate({ to: "/tickets/$id", params: { id: ticket.id } });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tickets, activeIndex, navigate]);

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: orpc.tickets.listPage.key() });

  const createMutation = useMutation(
    orpc.tickets.create.mutationOptions({ onSuccess: invalidateList }),
  );
  const setStatusMutation = useMutation(
    orpc.tickets.setStatus.mutationOptions({ onSuccess: invalidateList }),
  );

  // saved-views (spec: specs/saved-views.md): name the current filter combo and
  // persist it. The inline input opens from the "ビューとして保存" button; on
  // success it invalidates viewsList so the sidebar list (which reads the same
  // key) refreshes immediately. A blank name is caught client-side; a CONFLICT
  // from the server maps to the same alert region.
  const [showSaveView, setShowSaveView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const saveViewMutation = useMutation(
    orpc.tickets.viewsCreate.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.tickets.viewsList.key() });
        setViewName("");
        setViewError(null);
        setShowSaveView(false);
      },
      onError: (err) => {
        setViewError(
          (err as { code?: string }).code === "CONFLICT"
            ? "同名のビューがあります"
            : "ビューを保存できませんでした",
        );
      },
    }),
  );

  const onSaveView = () => {
    const trimmed = viewName.trim();
    if (trimmed.length === 0) {
      setViewError("ビュー名を入力してください");
      return;
    }
    // Only the active filters ride the payload — the server's strict schema wants
    // just the keys the user set, and at least one is present (hasFilter gated the
    // button).
    const filters: TicketSearch = {};
    if (search.status) filters.status = search.status;
    if (search.priority) filters.priority = search.priority;
    if (search.label) filters.label = search.label;
    saveViewMutation.mutate({ name: trimmed, filters });
  };

  // bulk-actions (spec: specs/bulk-actions.md). Selection + the bar's three
  // pending patch fields live here; the checkbox column and the bar are agent-
  // only. Empty select value means "leave as is"; the assignee "unassign"
  // sentinel maps to null.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkStatus, setBulkStatus] = useState<TicketStatus | "">("");
  const [bulkPriority, setBulkPriority] = useState<TicketPriority | "">("");
  const [bulkAssignee, setBulkAssignee] = useState<string>("");
  const [bulkError, setBulkError] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkStatus("");
    setBulkPriority("");
    setBulkAssignee("");
    setBulkError(false);
  };

  // Agent directory for the assignee select (spec: 既存 tickets.agents の結果).
  // Agent-only, mirroring the detail panel's gating.
  const agentsQuery = useQuery({
    ...orpc.tickets.agents.queryOptions(),
    enabled: isAgent,
    retry: false,
  });

  const bulkUpdateMutation = useMutation(orpc.tickets.bulkUpdate.mutationOptions());

  const onBulkApply = () => {
    const patch: {
      status?: TicketStatus;
      priority?: TicketPriority;
      assigneeEmail?: string | null;
    } = {};
    if (bulkStatus) patch.status = bulkStatus;
    if (bulkPriority) patch.priority = bulkPriority;
    if (bulkAssignee) patch.assigneeEmail = bulkAssignee === "unassign" ? null : bulkAssignee;
    setBulkError(false);
    bulkUpdateMutation.mutate(
      { ids: [...selectedIds], patch },
      {
        onSuccess: () => {
          invalidateList();
          clearSelection();
        },
        // 選択状態は維持しリトライ可能にする(spec)。
        onError: () => setBulkError(true),
      },
    );
  };

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

      {/* Server-side filter bar (spec: specs/triage.md). Empty option ("") is
          "all"; selecting it clears that filter. unassigned は受信トレイ専用なので
          ここには出さない。両ロールで使える。 */}
      <div className="flex items-center gap-3">
        <select
          data-testid="filter-status"
          aria-label="Filter by status"
          value={search.status ?? ""}
          onChange={(e) => setFilter({ status: (e.target.value || undefined) as TicketStatus })}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">すべて</option>
          {STATUS_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          data-testid="filter-priority"
          aria-label="Filter by priority"
          value={search.priority ?? ""}
          onChange={(e) => setFilter({ priority: (e.target.value || undefined) as TicketPriority })}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">すべて</option>
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          data-testid="filter-label"
          aria-label="Filter by label"
          value={search.label ?? ""}
          onChange={(e) => setFilter({ label: e.target.value || undefined })}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">すべて</option>
          {(labelsQuery.data ?? []).map((label) => (
            <option key={label.name} value={label.name}>
              {label.name}
            </option>
          ))}
        </select>
        {hasFilter && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="filter-clear"
            onClick={() => navigate({ search: {}, replace: true })}
          >
            クリア
          </Button>
        )}
        {/* saved-views (spec: specs/saved-views.md): agent-only, and only when at
            least one filter is active. The save button flips to an inline name
            input + confirm; Enter confirms too. */}
        {isAgent && hasFilter && !showSaveView && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="view-save"
            onClick={() => {
              setViewError(null);
              setShowSaveView(true);
            }}
          >
            ビューとして保存
          </Button>
        )}
        {isAgent && hasFilter && showSaveView && (
          <div className="flex items-center gap-2">
            <Input
              data-testid="view-name-input"
              aria-label="ビュー名"
              placeholder="ビュー名"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSaveView();
                }
              }}
              className="h-8 w-40"
            />
            <Button
              type="button"
              size="sm"
              data-testid="view-save-confirm"
              disabled={saveViewMutation.isPending}
              onClick={onSaveView}
            >
              保存
            </Button>
          </div>
        )}
      </div>

      {viewError && (
        <p data-testid="view-error" role="alert" className="text-sm text-destructive">
          {viewError}
        </p>
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
            selectable={isAgent}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onEndReached={onEndReached}
            height={listHeight || undefined}
            activeIndex={activeIndex}
          />
        </div>
      )}

      {/* 一括アクションバー (spec: specs/bulk-actions.md). 選択件数 > 0 のとき
          一覧下部に表示。どのセレクトも空なら適用は disabled。適用失敗時は
          bulk-error を出し選択は維持。 */}
      {isAgent && selectedIds.size > 0 && (
        <div
          data-testid="bulk-bar"
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span data-testid="bulk-count" className="text-sm text-foreground">
            {selectedIds.size}件選択
          </span>
          <select
            data-testid="bulk-status-select"
            aria-label="一括で status を変更"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value as TicketStatus | "")}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">Status</option>
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            data-testid="bulk-priority-select"
            aria-label="一括で priority を変更"
            value={bulkPriority}
            onChange={(e) => setBulkPriority(e.target.value as TicketPriority | "")}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">Priority</option>
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            data-testid="bulk-assignee-select"
            aria-label="一括で担当者を変更"
            value={bulkAssignee}
            onChange={(e) => setBulkAssignee(e.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">Assignee</option>
            <option value="unassign">担当解除</option>
            {(agentsQuery.data ?? []).map((agent) => (
              <option key={agent.email} value={agent.email}>
                {agent.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            data-testid="bulk-apply"
            disabled={
              (!bulkStatus && !bulkPriority && !bulkAssignee) || bulkUpdateMutation.isPending
            }
            onClick={onBulkApply}
          >
            適用
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="bulk-clear"
            onClick={clearSelection}
          >
            選択解除
          </Button>
          {bulkError && (
            <p data-testid="bulk-error" role="alert" className="text-sm text-destructive">
              一括更新に失敗しました。
            </p>
          )}
        </div>
      )}
    </main>
  );
}
