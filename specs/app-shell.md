# Feature: app-shell — Linear ライクな全幅レイアウトと仮想スクロール一覧

フェーズ2。認証後の全ページを「左固定サイドバー + 全幅メインペイン」の
App shell に置き換え、チケット一覧を TanStack Virtual + カーソルページネーション
(`tickets.listPage`、フェーズ1で実装済み)のインフィニティスクロールにする。
PC レイアウトのみ対象(レスポンシブ対応はしない)。API の変更は無い。

## ユーザーストーリー

- ユーザーとして、画面幅を使った Linear 風のレイアウトで作業したい
  (中央寄せの細いカラムと大きな左右余白をやめる)
- エージェントとして、チケットが増えても一覧がスクロールで滑らかに読み込まれてほしい

## 依存の追加

- `@tanstack/react-virtual`(apps/web)。追加はこれ1つだけ。
  ルートの pnpm-lock.yaml が更新されるため、コミット時は
  apps/web/package.json と pnpm-lock.yaml を必ず同時にステージする

## AppShell(apps/web/src/components/app-shell.tsx)

```ts
export function AppShell({ user, children }: { user: User; children: React.ReactNode });
```

- 画面全体: `h-dvh` の横 flex。左に固定幅サイドバー(`w-60`)、右がメイン
  ペイン(`flex-1 min-w-0 overflow-hidden`)。メインの中身はページが自分で
  スクロールを管理する(一覧はここが仮想スクロールになる)
- 認証後の全ルート(/tickets、/tickets/$id、/board、/ = index)が TopNav の
  代わりに AppShell でラップする。/login は対象外(現状のまま)
- `useRealtimeInvalidation()` は TopNav から AppShell に移す(サインイン中
  シェルとソケットの寿命を一致させる既存方針の維持)
- TopNav(apps/web/src/auth/TopNav.tsx)は AppShell に置き換えて削除する

### サイドバーの構成(上から)

- ワークスペース表示: 「サポートデスク」(太字・ブランド色の角丸マーク付きは任意)
- ナビゲーション(`<nav data-testid="app-sidebar">` がサイドバー全体のコンテナ):
  - `data-testid="nav-tickets"` — Link「Tickets」→ /tickets(全ロール)
  - `data-testid="nav-board"` — Link「Board」→ /board(**agent のみ**。customer には
    レンダリングしない — 既存 TopNav と同じ出し分け)
  - active なリンクは視覚的に区別(surface lift。詳細は自由)
- 下端(mt-auto):
  - `data-testid="current-user"` — user.name
  - パスキー登録(既存 TopNav の移植。testid・文言は現状維持:
    `passkey-register` ボタン「パスキーを登録」/ `passkey-registered`
    「パスキーを登録しました」/ `passkey-error`「登録に失敗しました」、
    supportsPasskeys() ガードも維持)
  - 「Sign out」ボタン(logout → router.invalidate → /login。現状の挙動を移植)

### 既存テストの更新(この仕様が要求する変更)

- auth.spec.ts と passkey.spec.ts の `getByTestId("top-nav")` への aria snapshot は
  `getByTestId("app-sidebar")` に変更する(snapshot 内容は「Sign out ボタンを含む」
  構造を維持)。それ以外の既存テストは testid・アクセシブルネームが不変のため
  変更しない

## 一覧(/tickets)の刷新

- ページ構成: メインペイン内で `px-6 py-4`。ヘッダ行(h1「Tickets」+
  「New ticket」ボタン + 作成フォーム。現状の挙動・testid を維持)、その下が
  一覧のスクロール領域(`flex-1` で残り高さ全部、`overflow-auto`)
- データ取得を `tickets.list` から **`tickets.listPage` の useInfiniteQuery** に変更:
  - limit 50、`nextCursor` を pageParam に渡す。ページの items を平坦化して表示
  - 並びはサーバの返却順のまま(created_at DESC)。クライアントで並べ替えない
  - 取得失敗は既存どおり `data-testid="tickets-load-error"`(retry: false)
  - create 成功・WS(`ticket.created` / `ticket.updated` / `message.created`)の
    invalidate 対象を listPage の infinite query に付け替える
- **仮想化**: TanStack Virtual(`useVirtualizer`)。スクロール要素は一覧の
  スクロール領域。行高は固定 48px(`estimateSize: () => 48`、行も h-12 で固定)
- **インフィニティスクロール**: 可視範囲の末尾が「読み込み済み件数 - 5」を
  超えたら次ページを fetch(hasNextPage && !isFetching のとき)。明示ボタンは
  置かない
- 行の中身・testid は現状維持(ticket-row / ticket-number / ticket-link /
  ticket-labels / ticket-label / ticket-assignee / ticket-status-select、
  固定幅グリッドの7カラム)。`data-testid="ticket-list"` は仮想化後も
  行の祖先要素に付いていること(既存テストのスコープに使われている)
- TicketList の公開シェイプ(component テストが単体マウントする):

```ts
export function TicketList({
  tickets, // 表示する全件(読み込み済みの平坦化済み配列)
  onStatusChange,
  showStatusControl = true,
  onEndReached, // 可視末尾が末尾-5行に達するたび呼ばれる(省略可)
  height, // スクロール領域の高さ(px)。省略時は親の高さに従う
}: {
  tickets: Ticket[];
  onStatusChange: (id: string, status: TicketStatus) => void;
  showStatusControl?: boolean;
  onEndReached?: () => void;
  height?: number;
});
```

## 詳細(/tickets/$id)と Board

- AppShell でラップする(TopNav 除去)以外、ページ内容は変更しない
  (詳細の2ペイン化はフェーズ3)。詳細の中身はメインペイン内で従来の
  カラム幅のまま(左寄せ・`max-w-3xl`)
- Board はメインペイン全幅に広げる(`max-w-5xl` を外す)

## E2E観点(@feature-app-shell)

1. @smoke(実バックエンド・agent): /tickets でサイドバー表示(app-sidebar 内に
   Tickets / Board リンク)→ 一覧に "Billing question" 行(SUP-2)が見える →
   サイドバーの Board リンクで /board へ → `kanban-column-open` 表示 →
   サイドバーの Tickets リンクで一覧に戻る。app-sidebar に aria snapshot
2. インフィニティスクロール(モックレーン): `page.route` で listPage を2ページ
   固定(1ページ目: subject "Bulk ticket 1".."Bulk ticket 50" の50件 +
   nextCursor あり / 2ページ目: "Bulk ticket 51".."Bulk ticket 60" + nextCursor
   null。他エンドポイントのスタブは visual.spec.ts の流儀)。
   一覧を最下部までスクロール → "Bulk ticket 60" の行が現れる(2ページ目が
   読み込まれた)。あわせて DOM 上の ticket-row 数が総数 60 より十分少ない
   ことを検証(仮想化の証拠。しきい値は < 40)
3. customer: サイドバーに Board リンクが**無い**・Tickets リンクはある・
   一覧に自分のチケット(既存シードアンカー)が表示される

## component観点(Vitest Browser Mode)

- TicketList 仮想化: 500件・height 指定でマウント → DOM の ticket-row が
  総数より大幅に少ない(< 50)/ スクロールで後半の行(例: 450件目の subject)が
  現れる / 末尾近くまでスクロールすると onEndReached が呼ばれる
- AppShell: agent で nav-board あり、customer で無し(user prop の出し分け)

## unit観点

- なし(API 変更なし。ページ連結・仮想化は component/E2E で担保)

## feature-map / タグ

- `"app-shell": ["apps/web/src/**", "e2e/tests/app-shell.spec.ts"]` を追加
- E2E は `@feature-app-shell`。@smoke は1本のみ。2 はモックレーン
  (@backend 不要)、1・3 は実バックエンド

## 備考(実装者向け)

- visual.spec.ts(VRT)のスタブ更新と baseline 再生成はメインセッションが
  統合フェーズで行う。実装側では触れない
- index ルート(/)が TopNav を使っている場合も AppShell に置き換える
- 一覧の仮想化行は absolute 配置になるため、固定幅グリッドのカラム定義は
  行要素側に残すこと(視覚は現状の7カラムを維持)
