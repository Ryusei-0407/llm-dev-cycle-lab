# Feature: kanban

チケットのカンバンボード。status 列(Open / In progress / Resolved)間のドラッグ&ドロップで
ステータスを変更する。**Vitest Browser Mode の本命検証対象**(実ブラウザの D&D は JSDOM 不可能領域)。

## UI(/board ルート、agent 専用)

- TopNav に "Board" リンク(data-testid="nav-board")。**agent のみ表示**。
  customer が直URLで /board へ → 既存の ticket-forbidden と同型の
  data-testid="board-forbidden" 表示(API は既存 list/setStatus の認可がそのまま守る)
- `apps/web/src/routes/board.tsx` + `apps/web/src/components/kanban-board.tsx`:
  - 3列: data-testid="kanban-column-open" / "kanban-column-in_progress" / "kanban-column-resolved"
    (列見出し: Open / In progress / Resolved、列内に件数バッジ data-testid="column-count")
  - カード: data-testid="kanban-card"(subject + priority 表示。Linear テーマ: feature-card 準拠、
    ドラッグ中は surface-2 リフト)
  - **HTML5 Drag and Drop API で実装**(draggable 属性 + dragstart/dragover/drop。
    外部D&Dライブラリは導入しない — ツール最小主義)
  - drop で `orpc.tickets.setStatus` を呼び、成功で列間移動を確定(楽観更新は任意)。
    失敗時は data-testid="board-error" 表示 + カードは元の列に留まる
- ボードのデータは既存 tickets.list(agent = 全件)

## component観点(Vitest Browser Mode — 本命)

apps/web/test-browser/kanban.test.tsx:

- KanbanBoard を Router 文脈下でマウント(ticket-status.test.tsx の流儀)し、
  fetch/oRPC をページ内スタブ
- (a) シード相当の tickets を渡し、各列への振り分けと件数バッジを検証
- (b) **実ブラウザの DragEvent で card を open 列 → in_progress 列へ D&D**し、
  setStatus スタブが {id, status:"in_progress"} で呼ばれ、カードが移動することを検証
  (dispatchEvent(new DragEvent("dragstart"/"dragover"/"drop", {dataTransfer})) を使う)
- (c) setStatus スタブを reject させ、board-error 表示 + カードが元の列に残ることを検証

## E2E観点(@feature-kanban)

- 正常(@smoke): agent で /board → 3列とシードの振り分け表示 → シードチケット
  "Cannot login to dashboard"(open)を in_progress 列へ D&D(page.dragAndDrop または
  mouse ステップ)→ 列移動を確認 → /tickets 一覧でも該当行の status が in_progress
  になっている(永続の確認)。最終状態に aria snapshot
  ※ 移動対象のシードはこのテスト内で status を戻す(または移動先前提のアサートを
  他テストに置かない)— 共有DBの他ファイルへの波及禁止(アンカー型アサーション規約)
  → **推奨: シードでなくテスト内で API 作成した専用チケットを動かす**(波及ゼロ)
- 失敗1: setStatus を page.route で 500 → board-error 表示 + カードが元の列に留まる
- 失敗2: customer で /board 直アクセス(storageState 上書き)→ board-forbidden 表示

## unit観点

- 列振り分けロジック(groupByStatus 等を切り出すなら)は BM で足りるため専用 unit 不要
