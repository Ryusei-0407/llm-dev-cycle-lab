# keyboard-nav: 一覧のキーボード操作(j/k/Enter/Esc)

## ユーザーストーリー

Linear のキーボードファースト操作の第一歩として、/tickets の一覧を
j / k(または ↓ / ↑)で行ハイライト移動し、Enter または o でその行の詳細を開き、
詳細ページから Esc で一覧へ戻りたい。マウスに手を伸ばさずトリアージが進むこと。
agent / customer 共通(ロール差なし)。

## 挙動仕様

### /tickets 一覧

- キーは **document レベルの keydown** で受ける(一覧がフォーカスを持っている必要は
  ない)。ただし次の場合は**何もしない**:
  - 修飾キー付き(metaKey / ctrlKey / altKey)
  - 入力系要素にフォーカスがあるとき(input / textarea / select / contenteditable)
  - コマンドパレットが開いているとき(既存 ⌘K。パレットの Escape ハンドリングを
    奪わない)
- `j` / `ArrowDown`: アクティブ行を次へ。未選択状態からは先頭行へ
- `k` / `ArrowUp`: アクティブ行を前へ。先頭でさらに押しても先頭に留まる(循環しない)
- 末尾でさらに j を押しても末尾に留まる。読み込み済み行数の範囲で動く
  (インフィニティスクロールの未ロード分へは進まない — 末尾到達で既存の追加ロードが
  発火する分には任せる)
- アクティブ行の表示: 該当 `ticket-row` に **`data-active="true"`** を付与し、
  背景を `bg-surface-2` にする(非アクティブ行には data-active を付けない)
- 仮想化リストのため、アクティブ行が可視窓の外に出る場合はスクロールして可視化する
  (@tanstack/react-virtual の scrollToIndex 相当)
- `Enter` / `o`: アクティブ行があるとき、その行の詳細 `/tickets/<id>` へ SPA 遷移。
  アクティブ行が無ければ何もしない
- フィルタ変更・再フェッチで行集合が変わったら、アクティブ index は範囲内に
  クランプする(行数減で範囲外になったら末尾へ)

### /tickets/<id> 詳細

- `Escape` で `/tickets` へ SPA 遷移(検索条件の復元は保証しない)。
  入力系要素へのフォーカス中・パレット表示中は何もしない(上と同じガード)

## 公開インターフェース

- 純ロジックを `apps/web/src/lib/list-keys.ts` に切り出す:

```ts
// 次のアクティブ index。current が null(未選択)なら delta の向きに関わらず 0。
// 0..count-1 にクランプ。count === 0 なら null。
export function nextActiveIndex(
  current: number | null,
  delta: 1 | -1,
  count: number,
): number | null;

// keydown を無視すべきターゲットか(input/textarea/select/contenteditable)。
export function isEditableTarget(target: EventTarget | null): boolean;
```

- 新しい API / data-testid は追加しない(既存 `ticket-row` に `data-active` 属性が
  増えるのみ)。既存の row クリック遷移・フィルタ・仮想化の契約は不変

## テスト観点(層割り当て)

- **unit(apps/web、node レーン)**: `nextActiveIndex` — 未選択+j→0、0+k→0(クランプ)、
  末尾+j→末尾、count=0→null、範囲外 current のクランプ。
  `isEditableTarget` — input / textarea / select / contenteditable=true の各要素で
  true、div で false、null で false
- **BM(Vitest Browser Mode、apps/web/test-browser/)**: TicketList を実 chromium で
  マウントし、j/k で data-active が移動し該当行に bg-surface-2 が付くこと、
  input フォーカス中は動かないことを検証(document keydown 駆動のため実ブラウザ層)
- **E2E 正常1(@smoke)**: /tickets で j → 先頭行が data-active、j → 2行目、k → 1行目、
  Enter → その行の詳細 URL へ遷移、Esc → /tickets に戻る。
  途中の step で「検索系 input にフォーカスして j を押してもアクティブ行が
  動かない」ことも同一テスト内で確認(E2E は正常1本に収める)
- E2E 失敗系: 専用のエラー UI を持つ失敗が存在しないため無し(規約の上限内)
- タグ: `@feature-keyboard-nav`。feature-map.json に登録:
  `"keyboard-nav": ["apps/web/src/lib/list-keys.ts", "apps/web/src/routes/tickets.tsx",
"apps/web/src/routes/tickets_.$id.tsx", "apps/web/src/components/ticket-list.tsx",
"e2e/tests/keyboard-nav.spec.ts"]`

## 実装メモ(制約)

- コマンドパレット(⌘K)・copilot(⌘/)の既存ショートカットと衝突しないこと
  (j/k/o/Enter/Esc は修飾なし単键のみ)
- アクティブ行の状態はページ(route)側で持ち、TicketList にはプロパティで渡す
  (TicketList 単体マウントのテスト容易性を保つ)。既存 props の互換は維持
- E2E のアサーションは `data-active` 属性と URL で行う(具体的な行の subject は
  テスト内で作成したアンカーを使う — 共有シードの順序に依存しない)
