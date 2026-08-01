# Feature: detail-panel — チケット詳細の2ペイン化(スレッド + プロパティパネル)

フェーズ3。詳細ページ(/tickets/$id)を「中央スレッド + 右プロパティパネル」の
2ペインに刷新する(モック02)。スレッドの吹き出しは shrink-to-fit をやめ、
**幅の揃った全幅行**にする(文字列長で幅が揺れない — フェーズ2までの固定幅方針の
スレッド適用)。API の変更は無い。PC レイアウトのみ。

## ユーザーストーリー

- エージェントとして、状態・担当者・ラベルなどのプロパティを右パネルで
  一覧・操作したい(Linear の Issue 詳細と同じ配置)
- ユーザーとして、メッセージの幅が内容の長さで揺れない読みやすいスレッドが欲しい

## レイアウト(AppShell のメインペイン内)

```
┌──────────────────────────────┬────────────┐
│ breadcrumb (Tickets › SUP-n) │            │
│ h1 subject                   │  ticket-   │
│ ─ thread(messages+events) ─ │ properties │
│ ─ AI draft panel ─          │  (w-64)    │
│ ─ reply composer ─          │            │
└──────────────────────────────┴────────────┘
```

- 外枠: 横 flex・`h-full`。左(スレッド列)は `flex-1 min-w-0 overflow-y-auto`
  で自身がスクロールし、中身は `max-w-3xl` を**左寄せ**(`mx-auto` しない)で
  `px-6 py-4`
- 右: `<aside data-testid="ticket-properties">` — `w-64` 固定・`border-l`・
  `overflow-y-auto`・全高。**agent / customer の両ロールで表示**する
  (customer は閲覧のみ — 下記)

## ヘッダ(スレッド列の先頭)

- パンくず `data-testid="ticket-breadcrumb"`: 「Tickets」リンク(→ /tickets)+
  区切り + `data-testid="ticket-number"`(`SUP-{number}` 形式 — 既存テストが
  参照するため形式維持)
- `data-testid="ticket-subject"` の h1(現状維持)
- ヘッダから StatusBadge とラベルチップ表示は**撤去**する(プロパティパネルへ
  移動。`ticket-labels` の表示はパネル側が持つ)

## プロパティパネル(components/ticket-properties.tsx)

公開シェイプ(component テストが単体マウントする。データ取得はルート側の責務):

```ts
export function TicketProperties({
  ticket,
  role, // "agent" | "customer"
  agents, // assignee セレクトの選択肢(customer のときは空配列でよい)
  labelCatalog, // ラベルトグルの選択肢(customer のときは空配列でよい)
  onStatusChange,
  onAssigneeChange,
  onLabelsChange,
}: {
  ticket: Ticket;
  role: "agent" | "customer";
  agents: { email: string; name: string }[];
  labelCatalog: Label[];
  onStatusChange: (status: TicketStatus) => void;
  onAssigneeChange: (assigneeEmail: string | null) => void;
  onLabelsChange: (labels: string[]) => void;
});
```

行構成(上から。各行はラベル(`w-16`・ink-tertiary)+ 値の固定レイアウト):

| 行     | agent                                                                                                                      | customer                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 状態   | `ticket-status-select`(既存 testid・選択肢 Open/In progress/Resolved)                                                      | StatusBadge 表示のみ                                |
| 優先度 | テキスト表示(capitalize。変更 API は無いので両ロール表示のみ)                                                              | 同左                                                |
| 担当者 | `assignee-select`(既存 testid・「未割り当て」(値 "")+ agents の name)                                                      | テキスト(`assigneeEmail` の @ 前、未割り当ては `–`) |
| ラベル | `label-toggle-{name}` トグル群(既存 testid。labelCatalog 全件、付与状態反映、クリックで全置換配列を onLabelsChange に渡す) | `ticket-labels` 内に `ticket-label` チップ表示のみ  |
| 依頼者 | `data-testid="ticket-requester"` に requesterEmail                                                                         | 同左                                                |
| 作成   | `createdAt` を `YYYY-MM-DD HH:mm`(UTC)で表示                                                                               | 同左                                                |
| 更新   | `updatedAt` を同形式で表示                                                                                                 | 同左                                                |

- agent のラベル行には現在付与中のチップ表示(`ticket-labels`)も含める
  (トグルは操作、チップは現在値 — smoke の既存アサーション
  「ticket-labels に api が現れる」を成立させる)
- ルート(tickets_.$id.tsx)は agent のときのみ tickets.agents / tickets.labels
  を fetch し(customer は呼ばない — agents は agent 専用 API)、
  ミューテーション成功時に detail を invalidate(現行と同じ)。
  ヘッダ下の操作ボックス(StatusControl/AssigneeControl/LabelControl の
  横並びボックス)は**撤去**しパネルに一本化する

## スレッドの行(components/message-thread.tsx — 描画のみ変更)

- 吹き出しの `max-w-[80%]` + 左右寄せをやめ、**全行 `w-full` の統一カード**にする:
  1行目に author(email)+ role 区別(customer/agent で左ボーダー色 or
  ロールチップ。手段は自由だが**幅・配置では区別しない**)+ 時刻、2行目に本文
- イベント行(`ticket-event`)は全幅の小さな muted 行(文言は既存仕様の完全一致
  形式を維持: `状態: {from} → {to}` 等)
- testid(`message-thread` / `ticket-event` 等)と props(`{ messages, events }`)は
  不変。時系列マージの挙動も不変

## E2E観点(@feature-detail-panel、実バックエンド)

1. @smoke(agent): New ticket で自前のチケットを作成(共有DBシードを変更
   しない)→ 詳細を開く → `ticket-properties` パネルに 状態セレクト・
   担当者セレクト・ラベルトグル・`ticket-requester`(agent 自身のメール)が
   見える → パネルの `ticket-status-select` で in_progress に変更 →
   スレッドにイベント行 `状態: open → in_progress` が現れ、パネルの表示も
   追従 → breadcrumb の「Tickets」リンクで一覧に戻れる。最終状態で
   `ticket-properties` に aria snapshot
2. customer: 自分のシードチケット詳細で `ticket-properties` が見え、
   セレクト・トグルが**存在しない**一方、状態バッジ・`ticket-requester`・
   ラベルチップ(該当チケットに付与があるもの)が見える

(スレッド行の幅統一は VRT の管轄 — E2E ではアサートしない)

## component観点(Vitest Browser Mode)

- TicketProperties: agent マウントで各コントロール(status/assignee/label
  toggle)が出て、操作でコールバックが正しい引数(status 値・email/null・
  全置換配列)で呼ばれる / customer マウントでコントロールが無く表示のみ /
  日付が `YYYY-MM-DD HH:mm` UTC で出る
- MessageThread: 行が role で幅・配置を変えないこと(全行が同一幅であることを
  offsetWidth 比較で検証)+ 既存の文言・時系列マージが不変であること

## unit観点

- なし(API 変更なし)

## feature-map / タグ

- `"detail-panel": ["apps/web/src/**", "e2e/tests/detail-panel.spec.ts"]`
- E2E は `@feature-detail-panel`。@smoke は1本のみ

## 既存テストへの影響(この仕様が要求・許容する変更)

- 既存の testid・文言(ticket-status-select / assignee-select /
  label-toggle-* / ticket-labels / ticket-label / ticket-number /
  ticket-subject / ticket-event / ticket-requester(新規)/ イベント文言)は
  維持されるため、**既存テストの変更は原則不要**
- 例外: ヘッダの StatusBadge 撤去により、詳細ページで `status-badge` を
  ヘッダ前提で見るテストがあれば(customer の閲覧行がパネル内 StatusBadge に
  なるだけなので通る想定)、落ちた場合はパネル内スコープへの修正を統合
  フェーズで裁定する

## 備考(実装者向け)

- visual.spec.ts(VRT)のスタブは現行のままで詳細ページが動く(get/labels/
  agents スタブ済み)。baseline 再生成は統合フェーズでメインが実施
- message-thread.story.tsx / ticket-list.story.tsx の見た目追従(全幅行の
  カタログ)は実装側で更新してよい(fixture 型は既に新フィールド対応済み)
- 日付表示は ISO 文字列から UTC で組み立てる(ローカル TZ に依存させない —
  VRT の決定性)
