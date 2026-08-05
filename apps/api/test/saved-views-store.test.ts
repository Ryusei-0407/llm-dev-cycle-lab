import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// saved-views extends the ticket store with a per-user saved-views surface
// (spec: specs/saved-views.md unit観点). The store gains three methods:
//   - createView({ userEmail, name, filters }) → SavedView { id, name, filters }
//   - listViews(userEmail) → SavedView[](自分のみ、created_at ASC, id ASC)
//   - deleteView({ id, userEmail }) → { ok: true }(自分のビューのみ、他人/不在は
//     NotFoundError = 存在漏えい防止)
// 同名(同一 userEmail)は ConflictError(UNIQUE 制約を検知して変換)。
// これらのメソッド・ConflictError はこのブランチにまだ存在しない(RED)。db.ts は
// 接続ヘルパ、store.ts は createTicketStore(pool) を公開する。
import { createPool, type Pool } from "../src/db.js";
import { createTicketStore, ConflictError, NotFoundError } from "../src/tickets/store.js";
// applySchemaAndSeed drops + recreates the schema and re-inserts the fixed seeds
// — the idempotent reset the store lane leans on for per-test isolation。
// user_views は seed 0 件(spec: 初期ビュー0件)なので、reset 後は自テストが作った
// 行だけが存在する。
import { applySchemaAndSeed } from "../../../scripts/test-db.mjs";

// Connection comes from the vitest globalSetup (apps/api/test/global-setup.ts).
// Never hardcode a connection string here — POLICY.md §共通規約.
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定: vitest globalSetup が一時DBを供給する前提(specs/database.md)",
    );
  }
  return url;
}

const AGENT = "agent@example.com";
const OTHER = "other-agent@example.com";
// UUID v7: 13桁目(version nibble)が '7'、17桁目(variant)が 8/9/a/b。作成 id は
// DB の uuidv7() 既定から来る(spec: id uuid DEFAULT uuidv7())ので、アプリは id を
// 生成しない — DB スタンプであることをアサートする。
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MISSING_ID = "00000000-0000-7000-8000-0000000000ff";

describe("saved-views store: createView/listViews/deleteView @feature-saved-views", () => {
  let pool: Pool;
  let store: ReturnType<typeof createTicketStore>;

  beforeAll(() => {
    pool = createPool(databaseUrl());
    store = createTicketStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await applySchemaAndSeed(databaseUrl());
  });

  it(
    "createView は id(uuidv7)を採番し、入れた filters をそのまま返す(jsonb roundtrip)",
    {
      annotation: {
        type: "description",
        description:
          "3キー(status/priority/label)を持つ filters で createView すると、DB 採番の uuidv7 id と入力どおりの name・filters を持つ SavedView が返り、jsonb の往復でキー・値が変質しないことを検証",
      },
    },
    async () => {
      const filters = { status: "open", priority: "high", label: "billing" } as const;
      const view = await store.createView({ userEmail: AGENT, name: "高優先度の未対応", filters });
      expect(view.id).toMatch(UUID_V7);
      expect(view.name).toBe("高優先度の未対応");
      expect(view.filters).toEqual(filters);
    },
  );

  it(
    "listViews は自分のビューのみを created_at ASC, id ASC(作成順)で返す",
    {
      annotation: {
        type: "description",
        description:
          "同一ユーザーで3件を順に createView すると listViews が作成順(created_at ASC, id ASC)でその3件を返し、他ユーザーの createView は自分の list に混ざらない(所有スコープ)ことを検証",
      },
    },
    async () => {
      await store.createView({ userEmail: AGENT, name: "ビューA", filters: { status: "open" } });
      await store.createView({ userEmail: AGENT, name: "ビューB", filters: { priority: "high" } });
      await store.createView({ userEmail: AGENT, name: "ビューC", filters: { label: "auth" } });
      // 他ユーザーのビューはスコープ外(list に出てはならない)。
      await store.createView({
        userEmail: OTHER,
        name: "他人のビュー",
        filters: { status: "resolved" },
      });

      const mine = await store.listViews(AGENT);
      expect(mine.map((v) => v.name)).toEqual(["ビューA", "ビューB", "ビューC"]);
      expect(mine.some((v) => v.name === "他人のビュー")).toBe(false);
    },
  );

  it(
    "createView は同一ユーザー内の同名を ConflictError にする",
    {
      annotation: {
        type: "description",
        description:
          "同じ userEmail で同名の createView を2回叩くと2回目が ConflictError を throw し(UNIQUE (user_email, name) を検知して変換)、別ユーザーなら同名でも作成できることを検証",
      },
    },
    async () => {
      await store.createView({ userEmail: AGENT, name: "重複名", filters: { status: "open" } });
      await expect(
        store.createView({ userEmail: AGENT, name: "重複名", filters: { priority: "low" } }),
      ).rejects.toBeInstanceOf(ConflictError);
      // 別ユーザーは同名でも衝突しない(UNIQUE は (user_email, name) 複合)。
      const other = await store.createView({
        userEmail: OTHER,
        name: "重複名",
        filters: { status: "open" },
      });
      expect(other.name).toBe("重複名");
    },
  );

  it(
    "deleteView は自分のビューを削除し { ok: true } を返す",
    {
      annotation: {
        type: "description",
        description:
          "自分が作ったビューを deleteView すると解決し、以降 listViews からそのビューが消えることを検証",
      },
    },
    async () => {
      const view = await store.createView({
        userEmail: AGENT,
        name: "消すビュー",
        filters: { status: "open" },
      });
      await expect(store.deleteView(AGENT, view.id)).resolves.toBeUndefined();
      const mine = await store.listViews(AGENT);
      expect(mine.some((v) => v.id === view.id)).toBe(false);
    },
  );

  it(
    "deleteView は他人のビュー id を(存在していても)NotFoundError にする",
    {
      annotation: {
        type: "description",
        description:
          "OTHER が所有するビューの実在 id を AGENT が deleteView すると NotFoundError を throw し(存在漏えい防止: 不在 id と同じ応答)、そのビューが OTHER の list に残っている=削除されていないことを検証",
      },
    },
    async () => {
      const othersView = await store.createView({
        userEmail: OTHER,
        name: "他人のビュー",
        filters: { status: "open" },
      });
      await expect(store.deleteView(AGENT, othersView.id)).rejects.toBeInstanceOf(NotFoundError);
      // 他人のビューは削除されず残る(所有者の list で確認)。
      const theirs = await store.listViews(OTHER);
      expect(theirs.some((v) => v.id === othersView.id)).toBe(true);
    },
  );

  it(
    "deleteView は不在 id を NotFoundError にする",
    {
      annotation: {
        type: "description",
        description:
          "存在しないビュー id を deleteView すると NotFoundError を throw することを検証(他人のビュー id と同じ応答で存在の有無を漏らさない)",
      },
    },
    async () => {
      await expect(store.deleteView(AGENT, MISSING_ID)).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});
