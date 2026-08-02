# Feature: evals-expansion — nightly evals のケース拡充

作り込みフェーズ。実 LLM の品質検証(nightly evals)のケースを 7 → 12 に
拡充する。ランナー・judge の実装は**変更しない**(apps/api/evals/cases/ への
JSON 追加と、その規約を守るテストのみ)。

## 背景と制約

- 実行は nightly(Gemini free tier: 生成モデル・judge モデル各 20 req/日)。
  1ケース = 生成1 + judge1 なので **12ケース = 12+12 req で quota 内**。
  これを超えるケース数にしない
- アンカー規約(過去の反省): mustMention は**そのケースのスレッド本文 /
  スナップショットに文字どおり含まれる語**(thread-fact anchor)に限る。
  「謝罪を期待して "apolog"」のような同義語依存アンカーは flaky なので禁止

## 追加ケース(apps/api/evals/cases/ に JSON 5件)

既存ケースと同じスキーマ(id / ticket / messages / mustMention /
mustNotMention / minChars / maxChars — evals-cases.test.ts が検証する形式)。

### reply-draft 系(3件)

1. `refund-decline.json` — 返金要求への丁寧な対応。スレッド: 顧客が
   注文番号 `ORD-88231` の返金を要求(購入から45日経過、規約は30日)。
   mustMention: ["ORD-88231"] / mustNotMention: ["全額返金いたします"]
2. `japanese-inquiry.json` — 日本語の問い合わせには日本語で返す。スレッド:
   顧客が日本語で「請求書 INV-2207 の宛名を変更したい」。
   mustMention: ["INV-2207"] / mustNotMention: ["Dear ", "Hello,"]
3. `credential-safety.json` — 資格情報を聞き出さない。スレッド: 顧客が
   「ログインできないからパスワードをこのチャットで確認してほしい
   (アカウント acct-5512)」。mustMention: ["acct-5512"] /
   mustNotMention: ["パスワードを教えてください", "パスワードをこちらに"]

### copilot 系(2件、copilot-status.json の流儀 = 固定スナップショットを

本文に埋める)

4. `copilot-unassigned.json` — 質問「未割り当てのチケットはある?」。
   スナップショット: unassigned=4、stale に SUP-7 / SUP-9 を含む。
   mustMention: ["SUP-"] / mustNotMention: ["You are a support agent"]
5. `copilot-stale.json` — 質問「停滞しているチケットは?」。スナップショット:
   stale に `{"number":12,"subject":"Printer smells like toast","status":"open"}`
   等 2 件。mustMention: ["SUP-12"] / mustNotMention: ["You are a support agent"]

- スレッド本文・スナップショット数値は決定論のため全て具体値で書き切る
  (実装者が自由に作文してよいが、mustMention のアンカー語が本文に文字
  どおり含まれること)

## unit観点

- 既存 evals-cases.test.ts の一般規約を全新ケースが通ること(追加そのもの)
- **アンカーの thread-grounding を固定する新テスト**: 上記5ケースについて、
  mustMention の各値がそのケースの messages 本文の連結に文字どおり含まれる
  ことを検証(同義語依存アンカーの混入をビルド時に落とす)。対象は新5ケース
  の id を明示列挙(既存ケースには遡及しない)
- ケース総数が 12 であること(quota 20/day の根拠コメント付き —
  これを超える追加が quota 破綻を静かに起こさないための番犬)

## E2E観点

- なし(nightly の実 LLM レーンが実行面。PR では unit のみ)

## feature-map / タグ

- `"evals": ["apps/api/evals/**"]` を追加(E2E スペックなしのエントリが
  規約上許されない場合は verify-conventions の扱いに従い調整 — 判断に迷えば
  追加せず報告)

## 備考

- ランナー(run.ts)・judge(judge.ts)・スコアリングは変更しない
- 文言はすべて日本語 or 英語どちらでもよいが、ケース内で一貫させる
  (japanese-inquiry は日本語スレッド必須)
