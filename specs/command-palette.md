# Feature: command-palette — ⌘K コマンドパレットとチケット検索

フェーズ4b。どの画面からも ⌘K(mac)/ Ctrl+K で開くコマンドパレットを追加し、
ナビゲーションとチケット検索(SUP-n / 件名)を提供する。API の追加は
`tickets.search` のみ。

## ユーザーストーリー

- ユーザーとして、キーボードだけで画面遷移とチケットへのジャンプをしたい
- エージェントとして、番号(SUP-12)や件名の断片からチケットを即座に開きたい

## サーバー(oRPC)

### 新規 `tickets.search`

```ts
input: { q: string }   // zod: trim 後 1..100 文字
output: Ticket[]       // 既存 Ticket ワイヤ形状。最大 20 件、created_at DESC, id DESC
```

- q が `/^(?:SUP-)?(\d+)$/i` にマッチ → **number 完全一致**で検索
  (`SUP-12` / `12` はどちらも number=12)
- それ以外 → **subject の部分一致(大文字小文字を区別しない ILIKE)**
- ロールスコープは list と同一(customer は自分所有のみ)。セッション必須
- 該当なしは空配列(エラーにしない)。ILIKE のメタ文字(% _)は
  エスケープしてリテラル扱いにする

## UI

### コマンドパレット(components/command-palette.tsx)

- shadcn の command / dialog(cmdk)を使ってよい(`pnpm dlx shadcn@latest add
command` — components.json は base-nova 設定済み)。追加依存はこの経路の
  もの(cmdk 等)のみ許可
- 開閉:
  - **⌘K(mac)/ Ctrl+K** のグローバルショートカット(AppShell 配下 =
    認証後全画面。入力欄フォーカス中でも開いてよい)
  - サイドバー上部の検索ボタン `data-testid="sidebar-search"`(表示「検索…」+
    `⌘K` のキーヒント)クリックでも開く
  - Esc / オーバーレイクリックで閉じる
- ダイアログ本体 `data-testid="command-palette"`、検索入力
  `data-testid="palette-input"`(placeholder「検索またはコマンド…」、
  開いたら自動フォーカス)
- 内容(上から):
  1. **ナビゲーション**(検索語が空でも表示。cmdk の組み込みフィルタで
     絞り込まれてよい):
     - `data-testid="palette-nav-inbox"`「受信トレイ」(**agent のみ**)
     - `data-testid="palette-nav-tickets"`「Tickets」
     - `data-testid="palette-nav-board"`「Board」(**agent のみ**)
     - 選択で該当ルートへ遷移しパレットを閉じる
  2. **チケット**(検索語が1文字以上のとき、`tickets.search` の結果):
     - 各行 `data-testid="palette-ticket"` — `SUP-{number}` + subject を表示
     - 選択で `/tickets/{id}` へ遷移しパレットを閉じる
     - 結果 0 件かつ検索語ありのときは cmdk の empty 表示
       `data-testid="palette-empty"`(「該当なし」)
- 検索は React Query(query key に q、`enabled: q.length > 0`、retry: false)。
  cmdk の組み込みフィルタは**チケット行には適用しない**(サーバ結果を
  そのまま出す — cmdk の shouldFilter を適切に制御)

### AppShell への配線

- ショートカットリスナと開閉 state は AppShell が持つ(認証後全画面で有効)。
  パレットは AppShell 内に1つだけマウント
- サイドバーの `sidebar-search` はワークスペース表示の直下に置く(モック01)

## E2E観点(@feature-command-palette、実バックエンド)

1. @smoke(agent): /tickets で **Ctrl+K** → `command-palette` が開き
   `palette-input` にフォーカス → 「Billing」と入力 → `palette-ticket` 行に
   `SUP-2` と "Billing question" → クリックで詳細(ticket-subject =
   "Billing question")へ遷移しパレットが閉じる → 再度 Ctrl+K →
   `palette-nav-board` 選択で /board に遷移(kanban-column-open 可視)
2. 番号検索と該当なし(agent): Ctrl+K → 「SUP-1」で "Cannot login to
   dashboard" の行が出る → 入力を「zzz-no-match-zzz」に変えると
   `palette-empty` 表示 → Esc でパレットが閉じる(command-palette 不可視)
3. customer: パレットに `palette-nav-board` / `palette-nav-inbox` が**無い**・
   `palette-nav-tickets` はある。さらに agent 所有チケット(テスト内で
   apiLogin(agent) + oRPC create で作成)の件名で検索してもヒットしない
   (ロールスコープ)。自分のシード件名ではヒットする

## component観点(Vitest Browser Mode)

- なし(パレットはルーター・クエリ・グローバルキーに強く結合するため
  E2E 層で担保。search のロジックは unit で網羅)

## unit観点

- store.search: subject 部分一致(大文字小文字非区別)/ `SUP-12`・`12` の
  number 完全一致 / 一致なし空配列 / `%` `_` をリテラル扱い(エスケープ)/
  requesterEmail スコープ / limit 20(21件作って20件まで)/ 並び
  created_at DESC
- schema(zod): q の trim・1..100・空文字拒否
- router(HTTP面): セッション必須(401)/ customer スコープ(agent 所有
  チケットが混入しない — triage-router の scope pin と同じ流儀)

## feature-map / タグ

- `"command-palette": ["apps/api/**", "apps/web/src/**", "e2e/tests/command-palette.spec.ts"]`
- E2E は `@feature-command-palette`。@smoke は1本のみ

## 備考(実装者向け)

- shadcn add で入るファイル(components/ui/command.tsx 等)は生成物として
  そのまま受け入れてよい(lint/型が通ること)。package.json + ルートの
  pnpm-lock.yaml は**必ず同時にステージ**(既知の罠)
- キーボードイベントは `e.metaKey || e.ctrlKey` + `e.key === "k"` で判定し
  preventDefault(ブラウザ既定の検索バーを抑止)
- VRT: パレットを開いた状態の baseline はメインが統合フェーズで追加する
  (実装側では visual.spec.ts に触れない)
