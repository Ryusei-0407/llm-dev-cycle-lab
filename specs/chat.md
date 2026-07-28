# Feature: chat

チャットの送受信。ユーザーがメッセージを送ると、アシスタントの応答が SSE で
ストリーミング表示される。

## ユーザーストーリー

- ユーザーとして、メッセージを送信するとアシスタントの返答が逐次表示されてほしい
- 失敗したときは何が起きたか分かる表示がほしく、すぐに再送できてほしい

## 公開インターフェース

- `POST /api/chat` — body: `{ messages: {role, content}[] }`
  - 200: `text/event-stream`。`data: {"delta": string}` の列 → `data: [DONE]`
  - 途中失敗: `data: {"error": string}` を送って終了([DONE] なし)
  - 400: messages 欠落 / 不正 JSON。500: プロバイダ失敗
- data-testid: `message-user`, `message-assistant`, `typing-indicator`,
  `error-banner`, `message-list`
- 入力欄: `aria-label="Message"`。ボタン: `Send` / `Stop`(ストリーミング中のみ)

## E2E 観点(モック、@feature-chat)

- 正常系(@smoke): 送信 → ユーザーメッセージ表示 → インジケータ表示→消滅 → 応答全文表示、エラーバナーなし
- 失敗系1: API が 500 → エラーバナー表示、アシスタントメッセージなし、入力欄は再度有効
- 失敗系2: ストリーム途中で error イベント → 部分テキストは残し、エラーバナー表示

## ユニットテスト観点

- SSE パーサ(チャンク境界分割への耐性、[DONE]、error イベント、不正データ無視)
- chat reducer(start/delta/done/error の状態遷移、エラー時の空バブル除去と部分保持)
- API ルート(400/500、SSE 形式、途中失敗イベント)
- MockProvider の決定性(同一入力 → 同一チャンク列)
