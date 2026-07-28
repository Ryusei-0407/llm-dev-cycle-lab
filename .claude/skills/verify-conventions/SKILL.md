---
name: verify-conventions
description: docs/POLICY.md のテスト規約(E2E本数上限、タグ、snap/test.step、固定待ち禁止等)への適合を機械検証し、違反ゼロまで修正する検証ループ。テストを書いた・変更した後、および規約違反が疑われるときに使う。
---

# verify-conventions: 規約の検証ループ

POLICY のテスト規約のうち決定論的に判定できるものは
`scripts/verify-conventions.mjs` がルール化している(汎用リンターでは
捕まえられないプロジェクト固有ルール)。

## ループ

1. `node scripts/verify-conventions.mjs` を実行
2. 違反(`file:line [rule] 内容`)を1件ずつ修正する。機械的に直すのではなく、
   ルールの意図(docs/POLICY.md 共通規約)に沿って直す:
   - `e2e-budget` 超過 → テストを消すのではなく「機能分割すべきか」をまず考える。
     反証フェーズ由来のテストならタイトルに `@pinned` を付ける(それが免除の根拠)
   - `no-fixed-wait` → その待ちが何を待っているかを特定し、対応する
     web-first assertion に置き換える
3. 違反ゼロ(`OK`)になるまで 1-2 を繰り返す
4. 最後に `pnpm check` 全体を通す(fmt / lint / 型も含めて)

## ルールを増やすとき

新しい規約を POLICY に足したら、決定論的に判定できる部分を
`scripts/verify-conventions.mjs` に同時に追加する(規約とルールの乖離を作らない)。
判定できない部分は adversarial-reviewer の観点に足す。
