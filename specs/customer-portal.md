# Feature: customer-portal

顧客ロールでのサポートデスク体験。温存してきた customer storageState(e2e/.auth/customer.json)を
初めて実戦投入する。authz(API側の認可)が前提。

## クライアントのロール把握

- ルートガードで取得済みの /api/auth/me のユーザー(email/role)を Router context 経由で
  ページから参照できるようにする(実装位置は自由、公開名は `useSessionUser()` フック
  — apps/web/src/lib/session.ts)

## UI のロール適応

- /tickets 一覧: customer では「担当者向け操作」を出さない —
  **status 変更 select を非表示**(data-testid="ticket-status-select" が存在しないこと)。
  一覧は API が自分の分しか返さないのでそのまま
- /tickets/$id 詳細: customer では **Generate draft ボタン非表示**。返信は可(自分のチケット)
- 他人のチケットに customer が到達した場合(直URL): API の FORBIDDEN を受けて
  data-testid="ticket-forbidden" の表示(not-found とは別文言)
- agent の見た目・挙動は完全無変更

## E2E観点(@feature-customer-portal、customer storageState で実行)

テストファイル冒頭で `test.use({ storageState: "e2e/.auth/customer.json" })`(パスは setup の出力に合わせる)。

- 正常(@smoke): customer で /tickets → シード(全て customer 所有)が見える・status select が無い →
  自分のチケット詳細を開く → Generate draft が無い → 返信できる。最終状態に aria snapshot
- 失敗1: **agent が作ったチケット**への直アクセス → ticket-forbidden 表示。
  agent のチケットは、テスト内で Playwright の request コンテキスト
  (e2e/helpers/auth.ts の apiLogin で agent ログイン)から oRPC create を直接叩いて用意する
  (シードは変更しない — 決定的かつ他テストへ波及しない)
- 失敗2: customer の一覧に agent 作成チケットが混入しない(失敗1と同じ準備を流用し、
  一覧に subject が現れないことを検証)

## unit観点

useSessionUser は E2E で間接検証(専用 unit は不要。ロジックが薄いため)。
