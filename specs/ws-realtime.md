# Feature: ws-realtime

チケットの変更(作成・ステータス変更・返信)を WebSocket で全クライアントへ通知し、
一覧・詳細・ボードが自動更新される。**Playwright routeWebSocket / マルチコンテキストの検証対象**。

## サーバー(apps/api)

- `apps/api/src/realtime.ts`: `createRealtimeHub()` → { register(ws), broadcast(event), size() }
  (in-memory の接続集合。イベント形式: `{ type: "ticket.created" | "ticket.updated" | "message.created", ticketId: string }`)
- WS エンドポイント `/api/ws`(Hono の upgradeWebSocket、@hono/node-ws)。
  **セッション必須**: cookie の sid を resolveUser で検証し、未認証は接続拒否(close code 1008)
- broadcast 発火点: tickets.create / tickets.setStatus / tickets.reply の成功後
  (router から hub を注入。draft は通知しない)
- ペイロードに機密を載せない(type と ticketId のみ。受信側が自分の権限で再取得する設計 —
  認可は既存 list/get が守る)

## クライアント(apps/web)

- `apps/web/src/lib/realtime.ts`: `useRealtimeInvalidation()` — /api/ws へ接続し、
  イベント受信で対応する TanStack Query キーを invalidate
  (ticket.created/updated → tickets.list + 該当 get、message.created → 該当 get)。
  再接続: 切断時に指数バックオフ(初回1s、最大30s)で再接続
- __root.tsx(認証済みレイアウト)で常時有効化
- UI 変更なし(既存画面が invalidate で自動更新されるだけ)

## unit観点(apps/api/test/realtime.test.ts)

- createRealtimeHub: register/broadcast/切断除去(モック ws オブジェクトで)
- broadcast 発火: HTTP 面から create/setStatus/reply を実行し、hub のモック(または
  テスト用フック)が対応イベントを受けることを検証
- /api/ws の認証拒否(未認証 upgrade → 1008)は統合が難しければ E2E 委譲を明記

## E2E観点(@feature-ws-realtime)

- 正常(@smoke): **マルチコンテキスト** — agent コンテキストAで /tickets を開き、
  別コンテキストB(agent の request でよい)が API でチケット作成 → **Aが reload なしで**
  新チケットを一覧に表示するのを待つ(自動更新の実証)。最終状態に aria snapshot
- 失敗1: `page.routeWebSocket` で /api/ws をブロック(接続させない)→ アプリは
  壊れず動作(WS はプログレッシブエンハンスメント。一覧表示・手動操作が正常)
- 失敗2: WS 切断(routeWebSocket で一度接続後に close)→ 再接続が試みられ、
  再接続後の変更が反映される(可能なら。Playwright の ws モックで難しければ
  「切断してもアプリがエラーUIを出さない」までに緩めてよい — 判断を報告)

## 注意

- E2E の webServer は dev サーバ(vite proxy)。**WS が vite の /api proxy を通るか要確認**
  (`ws: true` オプションが必要な可能性)。通らない場合は client を API_PORT 直結にせず
  proxy 設定側を直す(接続情報をコードに書かない原則)
