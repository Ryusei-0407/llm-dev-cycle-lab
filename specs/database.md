# Feature: database

tickets ストアを PostgreSQL に移行し、テストは**コンテナの一時DB**にスキーマとモックデータを
投入して実行する。auth(ユーザー/セッション)は本マイルストーンでは in-memory のまま。

## DB とスキーマ

- PostgreSQL 16(`postgres:16-alpine` コンテナ)
- スキーマ(`apps/api/db/schema.sql`):

```sql
CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved')),
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  requester_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- シード(`apps/api/db/seed.sql`): 既存の決定的3件。**id は固定 UUID**(例: 00000000-0000-4000-8000-000000000001〜03)、
  created_at も固定値で並び順が決定的になるようにする(subject/status/priority/requester は specs/tickets.md と同一)

## 一時DBの供給(scripts/test-db.mjs)

2モード。判定は `DATABASE_URL` の有無:

- **ローカル(provision モード)**: `DATABASE_URL` 未設定なら `docker run -d --rm` で postgres:16-alpine を
  空きポート・ユニーク名(例: llmlab-pg-$RANDOM)で起動 → 起動待ち → schema+seed 投入 → 接続URLを返す。
  `--teardown` でコンテナ停止。**並列 worktree で衝突しないこと**(固定ポート・固定名を使わない)
- **CI/BYO(reset モード)**: `DATABASE_URL` があればそのDBに対して DROP/CREATE スキーマ + seed のみ実行
  (CI は GitHub Actions の postgres service container を使う)
- 共通: `applySchemaAndSeed(url)` は冪等(DROP TABLE IF EXISTS → CREATE → INSERT)

## ストア移行(apps/api/src/tickets/store.ts)

- `pg` の Pool を使う非同期実装に変更。**公開インターフェース**:

```ts
createTicketStore(pool: Pool): {
  list(): Promise<Ticket[]>;            // created_at DESC, id DESC で決定的
  create(input: { subject; priority; requesterEmail }): Promise<Ticket>;
  setStatus(id: string, status: TicketStatus): Promise<Ticket>; // 不在は NotFoundError を throw
}
```

- zod スキーマ(schema.ts)・tRPC router の入出力契約・HTTPエンドポイントは**無変更**
  (router 内部が await するだけ。UI も無変更)
- Pool は `DATABASE_URL` から生成(apps/api/src/db.ts に接続ヘルパー)。未設定で tickets 機能に
  アクセスした場合は 500 `{error:"db_misconfigured"}`(gemini の provider_misconfigured と同型)

## テスト戦略(レーン別)

- **unit(純ロジック)**: zod スキーマテストは無変更で緑のまま
- **store 統合テスト(apps/api/test/tickets-store.test.ts)**: 一時DBに対して実行する形に書き直す。
  vitest の globalSetup(apps/api/test/global-setup.ts 等)で test-db.mjs を使い провision/reset、
  各テストは beforeEach で seed リセット(truncate + insert)して分離(M1 の共有ストア汚染の教訓)
- **E2E**: playwright globalSetup で一時DB を provision(または DATABASE_URL 利用)し、
  webServer(api)の env に DATABASE_URL を渡す。**既存の tickets E2E 3本はテストコード無変更で
  緑になること**(ストア差し替えの後方互換の証明)
- **CI**: unit / e2e ジョブに postgres service container を追加し DATABASE_URL を設定
  (llm-smoke / nightly full も同様)

## E2E観点

新規E2Eなし。既存 @feature-tickets 3本の無変更グリーンが受け入れ条件。

## unit/統合観点

- store: list の決定的順序 / create のバリデーションと永続化(再接続後も残る=同一Pool内で再取得)/
  setStatus / NOT_FOUND / seed リセットの分離(連続テストで件数が汚染されない)
- test-db: DATABASE_URL 有無での2モード分岐(docker 起動はモックせず実 docker で1ケース検証してよい)
