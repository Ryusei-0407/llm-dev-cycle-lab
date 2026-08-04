# saved-views: フィルタの名前付き保存ビュー(サーバ永続)

## ユーザーストーリー

agent として、/tickets の現在のフィルタ組合せ(status / priority / label)に名前を
付けて保存し、サイドバーの「ビュー」節(既存プリセット「高優先度」「未対応のみ」の下)
からワンクリックで適用したい。ビューは自分専用でサーバに永続し、リロード・再ログイン
後も残る。不要になったら削除できる。customer にはこの機能は一切見えない。

## データモデル(apps/api/db/schema.sql に追加)

```sql
CREATE TABLE user_views (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_email text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  filters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_email, name)
);
```

- schema.sql 先頭の DROP 群に `DROP TABLE IF EXISTS user_views;` を追加(他テーブルと
  FK 関係なし)。seed 追加は不要(初期ビュー0件)
- filters の形: `{"status"?: "open"|"in_progress"|"resolved", "priority"?: "low"|"medium"|"high", "label"?: string(1..32)}`
  — **少なくとも1キー必須**

## 公開インターフェース(oRPC、tickets ルータに追加)

ワイヤは既存と同じ `{"json": <入出力>}` 封筒。全て **セッション必須 + agent 専用**
(未認証 UNAUTHORIZED / customer は FORBIDDEN)。realtime broadcast は行わない
(ビューは個人設定でチケットデータではない)。

型:

```ts
export type SavedViewFilters = {
  status?: TicketStatus;
  priority?: TicketPriority;
  label?: string;
};
export type SavedView = { id: string; name: string; filters: SavedViewFilters };
```

- `tickets.viewsList`(入力なし)→ `SavedView[]`
  - 自分(セッション email)のビューのみ。並びは created_at ASC, id ASC(作成順で安定)
- `tickets.viewsCreate` 入力 `{ name: string, filters: SavedViewFilters }` → 作成した `SavedView`
  - zod: name は trim 後 1..32(空・空白のみは BAD_REQUEST)。filters は上記3キーのみ・
    少なくとも1キー(`.refine`)。未知キーは strict に拒否
  - 同一ユーザー内の同名は `ORPCError("CONFLICT")`(UNIQUE 制約を検知して変換)
- `tickets.viewsDelete` 入力 `{ id: uuid }` → `{ ok: true }`
  - **自分のビューのみ削除できる。他人のビュー id は(存在していても)NOT_FOUND**
    (存在の漏えい防止 — 不在 id と同じ応答)

ワイヤ例(実値):

```
POST /api/rpc/tickets/viewsCreate
body: {"json":{"name":"高優先度の未対応","filters":{"status":"open","priority":"high"}}}
200:  {"json":{"id":"<uuid>","name":"高優先度の未対応","filters":{"status":"open","priority":"high"}}}
```

## UI

### /tickets フィルタバー(apps/web/src/routes/tickets.tsx)

- agent かつ フィルタが1つ以上有効(既存 `hasFilter` 相当)のとき「ビューとして保存」
  ボタン `data-testid="view-save"` を表示
- クリックでインライン入力 `data-testid="view-name-input"`(placeholder「ビュー名」)と
  確定ボタン `data-testid="view-save-confirm"` が現れる。Enter でも確定
- 成功: 入力 UI が閉じ、サイドバーの一覧が即時更新される(viewsList の invalidate)
- 失敗表示 `data-testid="view-error"`(role="alert"):
  - 空・空白のみの名前 →「ビュー名を入力してください」(送信せずクライアントで弾いて良い)
  - CONFLICT →「同名のビューがあります」

### サイドバー(apps/web/src/components/app-shell.tsx)

- 既存プリセット2つ(sidebar-view-high / sidebar-view-open)の直下に自分のビューを列挙
- 各ビューは Link `data-testid="sidebar-user-view"`(アクセシブルネーム = ビュー名)
  → `/tickets?status=…&priority=…&label=…`(filters にあるキーだけを search に載せる)
- 行内に削除ボタン `data-testid="sidebar-user-view-delete"`
  `aria-label="Delete view <ビュー名>"`。クリックで即削除(確認ダイアログなし)、
  一覧から消える
- ドット色は `var(--brand)`(プリセットの bg-high / bg-warn と同じ 7px 円)
- customer にはビュー節ごと出さない(既存の isAgent 出し分けの中)

## テスト観点(層割り当て)

- **unit(apps/api/test/)**: store 層 `createView/listViews/deleteView` —
  所有スコープ(他ユーザーのビューが list に混ざらない)、同名 CONFLICT、
  他人の id の delete が NOT_FOUND、filters jsonb の roundtrip(入れた形がそのまま
  返る)。router 層 — customer の viewsList/viewsCreate/viewsDelete が FORBIDDEN、
  未認証が UNAUTHORIZED
- **E2E 正常1(@smoke)**: agent がフィルタ(priority=high)を適用 → 保存(名前入力)
  → サイドバーに出る → 別ページへ移動後クリックで /tickets?priority=high に遷移し
  フィルタ適用 → リロード後も残存 → 削除で消える
- **E2E 失敗2**:
  1. 空名のまま確定 → view-error 表示、viewsCreate は呼ばれない
  2. customer セッション: サイドバーにビュー節が無い(sidebar-user-view が 0 件)
     + `request` で viewsCreate 直 POST → FORBIDDEN(403 相当のエラー封筒)
- 最終状態に aria snapshot 1枚(サイドバーの nav 構造: role と順序のみ)
- タグ: `@feature-saved-views`。feature-map.json に登録:
  `"saved-views": ["apps/api/src/tickets/store.ts", "apps/api/src/tickets/router.ts",
  "apps/api/src/tickets/schema.ts", "apps/api/db/schema.sql",
  "apps/web/src/components/app-shell.tsx", "apps/web/src/routes/tickets.tsx",
  "e2e/tests/saved-views.spec.ts"]`

## 実装メモ(制約)

- 既存の一覧・triage のフィルタ URL 契約(/tickets?status=&priority=&label=)を変えない
- store は既存 createTicketStore の流儀(pool 注入、エラーは NotFoundError /
  BadRequestError 系の既存例外 + 新規 ConflictError があれば router で変換)
- E2E は共有シードを変更しない(アンカー型)。作成するビュー名はテスト内で一意に
