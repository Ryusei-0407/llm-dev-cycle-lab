import { StatusBadge } from "./status-badge";

// VRT カタログストーリー: 全状態を1枚に並べ、コンポーネント単位の見た目を
// e2e/components/visual.spec.ts が baseline 比較する(Storybook 相当の運用)。
export const VisualCatalog = () => (
  <div className="flex items-center gap-3 bg-background p-6">
    <StatusBadge status="open" />
    <StatusBadge status="in_progress" />
    <StatusBadge status="resolved" />
  </div>
);
