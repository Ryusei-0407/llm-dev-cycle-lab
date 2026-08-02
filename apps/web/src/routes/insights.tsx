import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";
import { LabelChart, TrendChart } from "@/components/insight-charts";
import { orpc } from "@/lib/orpc";
import { useSessionUser } from "@/lib/session";

// Auth guard mirrors /board: resolve the session in beforeLoad and redirect
// unauthenticated visitors before any insights UI mounts (specs/auth.md).
export const Route = createFileRoute("/insights")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: InsightsRoute,
});

function InsightsRoute() {
  const { user } = useLoaderData({ from: "/insights" });
  return (
    <AppShell user={user}>
      <InsightsPage />
    </AppShell>
  );
}

// The stat cards read from the same aggregate the charts do; each card pairs a
// label with the value under insight-value (spec).
const STAT_CARDS = [
  { key: "open", testid: "insight-stat-open", label: "未対応" },
  { key: "in_progress", testid: "insight-stat-in_progress", label: "進行中" },
  { key: "resolved", testid: "insight-stat-resolved", label: "解決済" },
  { key: "unassigned", testid: "insight-stat-unassigned", label: "未割り当て" },
] as const;

function InsightsPage() {
  // insights is agent-only (spec). A customer reaching /insights directly lands
  // on the dedicated forbidden panel (board-forbidden の流儀); the API insights
  // authz still holds regardless of this UI gate.
  const isAgent = useSessionUser()?.role === "agent";

  const insightsQuery = useQuery({
    ...orpc.tickets.insights.queryOptions(),
    retry: false,
    enabled: isAgent,
  });

  if (!isAgent) {
    return (
      <main className="flex h-full flex-col gap-4 overflow-auto px-6 py-4">
        <p
          data-testid="insights-forbidden"
          role="alert"
          className="rounded-lg border border-hairline bg-surface-1 p-4 text-sm text-ink-muted"
        >
          インサイトはエージェント専用です。
        </p>
      </main>
    );
  }

  const data = insightsQuery.data;
  const stats = data
    ? {
        open: data.byStatus.open,
        in_progress: data.byStatus.in_progress,
        resolved: data.byStatus.resolved,
        unassigned: data.unassigned,
      }
    : null;

  return (
    <main className="flex h-full w-full flex-col gap-6 overflow-auto px-6 py-4">
      <h1 className="text-xl font-semibold tracking-tight">インサイト</h1>
      {insightsQuery.isError ? (
        <p data-testid="insights-error" role="alert" className="text-sm text-destructive">
          読み込みに失敗しました。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            {STAT_CARDS.map((card) => (
              <div
                key={card.key}
                data-testid={card.testid}
                className="w-40 rounded-lg border border-hairline bg-surface-1 px-4 py-3"
              >
                <span className="text-sm text-ink-subtle">{card.label}</span>
                <span
                  data-testid="insight-value"
                  className="mt-1 block text-2xl font-semibold tabular-nums tracking-tight"
                >
                  {stats ? stats[card.key] : "—"}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section
              data-testid="insight-chart-trend"
              className="rounded-lg border border-hairline bg-surface-1 p-4"
            >
              <h2 className="mb-3 text-sm font-medium text-ink-muted">解決数の推移</h2>
              <TrendChart data={data?.resolvedByDay ?? []} />
            </section>
            <section
              data-testid="insight-chart-labels"
              className="rounded-lg border border-hairline bg-surface-1 p-4"
            >
              <h2 className="mb-3 text-sm font-medium text-ink-muted">ラベル別件数</h2>
              <LabelChart data={data?.byLabel ?? []} />
            </section>
          </div>
        </>
      )}
    </main>
  );
}
