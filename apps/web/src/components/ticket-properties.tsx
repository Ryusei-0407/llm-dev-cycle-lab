import { StatusBadge } from "@/components/status-badge";
import type { Label, Ticket, TicketPriority, TicketStatus } from "@/lib/tickets";

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

// 担当者メールの表示は @ 前の局所部だけ。未割り当ては en-dash。
// (ticket-list.tsx の assigneeLabel と同じ流儀。)
function assigneeLabel(email: string | null): string {
  if (!email) return "–";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// ISO 文字列から UTC で YYYY-MM-DD HH:mm を組み立てる。ローカル TZ に依存させない
// (VRT の決定性 — spec: detail-panel.md 備考)。
function formatUtc(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// プロパティ行: 固定幅ラベル(w-16・ink-tertiary)+ 値。
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="w-16 shrink-0 py-0.5 text-ink-tertiary">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// 詳細ページ右の properties パネル(spec: detail-panel.md)。データ取得はルート側の
// 責務で、ここは受け取った ticket/agents/labelCatalog を描画・操作するだけ。
// agent は各行が編集コントロール、customer は閲覧のみ。
export function TicketProperties({
  ticket,
  role,
  agents,
  labelCatalog,
  onStatusChange,
  onPriorityChange,
  onAssigneeChange,
  onLabelsChange,
}: {
  ticket: Ticket;
  role: "agent" | "customer";
  agents: { email: string; name: string }[];
  labelCatalog: Label[];
  onStatusChange: (status: TicketStatus) => void;
  onPriorityChange: (priority: TicketPriority) => void;
  onAssigneeChange: (assigneeEmail: string | null) => void;
  onLabelsChange: (labels: string[]) => void;
}) {
  const isAgent = role === "agent";
  const labels = ticket.labels ?? [];
  const active = new Set(labels.map((l) => l.name));

  const toggle = (name: string) => {
    const next = new Set(active);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onLabelsChange([...next]);
  };

  const labelChips = (
    <span data-testid="ticket-labels" className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
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
  );

  return (
    <aside
      data-testid="ticket-properties"
      className="h-full w-64 shrink-0 overflow-y-auto border-l border-hairline"
    >
      <div className="flex flex-col gap-3 p-4">
        <Row label="状態">
          {isAgent ? (
            <select
              data-testid="ticket-status-select"
              aria-label="Status"
              value={ticket.status}
              onChange={(e) => onStatusChange(e.target.value as TicketStatus)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
            </select>
          ) : (
            <StatusBadge status={ticket.status} />
          )}
        </Row>

        <Row label="優先度">
          {isAgent ? (
            <select
              data-testid="priority-select"
              aria-label="Priority"
              value={ticket.priority}
              onChange={(e) => onPriorityChange(e.target.value as TicketPriority)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          ) : (
            // CSS capitalize だと DOM テキストは生値のままになる。セレクトの
            // ラベル(Low/Medium/High)と同じ表記を実テキストで出す。
            <span>{PRIORITY_LABELS[ticket.priority]}</span>
          )}
        </Row>

        <Row label="担当者">
          {isAgent ? (
            <select
              data-testid="assignee-select"
              aria-label="Assignee"
              value={ticket.assigneeEmail ?? ""}
              onChange={(e) => onAssigneeChange(e.target.value || null)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">未割り当て</option>
              {agents.map((agent) => (
                <option key={agent.email} value={agent.email}>
                  {agent.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{assigneeLabel(ticket.assigneeEmail ?? null)}</span>
          )}
        </Row>

        <Row label="ラベル">
          {isAgent ? (
            // トグルが現在値表示を兼ねる(付与中 = 不透明 + ticket-label)。
            // 別行のチップ表示を重ねると同じラベルが二重に見えるため置かない。
            <div data-testid="ticket-labels" className="flex flex-wrap items-center gap-2">
              {labelCatalog.map((label) => {
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
                    {on ? <span data-testid="ticket-label">{label.name}</span> : label.name}
                  </button>
                );
              })}
            </div>
          ) : (
            labelChips
          )}
        </Row>

        <Row label="依頼者">
          <span data-testid="ticket-requester">{ticket.requesterEmail}</span>
        </Row>

        <Row label="作成">
          <span className="tabular-nums">{formatUtc(ticket.createdAt)}</span>
        </Row>

        <Row label="更新">
          <span className="tabular-nums">{formatUtc(ticket.updatedAt ?? ticket.createdAt)}</span>
        </Row>
      </div>
    </aside>
  );
}
