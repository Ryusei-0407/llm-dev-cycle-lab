# evals: reply-draft の LLM 応答品質回帰テスト

DESIGN.md のテスト層表で計画済みだった「Evals(応答の品質・回帰)/ 実LLM / 別ジョブ」を
実装する。対象はビジネス上最重要の LLM 機能 = **reply-draft(返信ドラフト生成)**。

## ユーザーストーリー

サポートデスク運営者として、モデル更新やプロンプト変更で返信ドラフトの品質が
劣化していないかを nightly で自動検知したい。品質は「決定的チェック」と
「LLM-as-judge のルーブリック採点」の2軸で測り、閾値割れで nightly が赤くなる。

## 方針(制約)

- **本番と同一のプロンプト経路を評価する**: ケースから
  `buildDraftSystemPrompt()` + `buildDraftMessages(ticket, messages)`
  (apps/api/src/tickets/draft.ts の既存 export)でプロンプトを組み立て、
  本番と同じモデル(`process.env.GEMINI_MODEL ?? "gemini-flash-latest"`)を呼ぶ。
  API サーバや DB は起動しない(ドラフト経路のプロンプト組み立ては純関数)。
- **新規依存ゼロ**: 生成は `@google/genai`(既存依存)を直接使う。judge も同
  ライブラリの JSON モード(`responseMimeType: "application/json"` +
  `responseSchema`)で実装する。promptfoo 等は導入しない(POLICY §6)。
- **注入可能なシーム**: 実LLM呼び出し(生成・judge とも)は関数注入で差し替え
  可能にする。ユニットテストはネットワークに一切触れない。
- 実行コスト: ケースは 6 件・各1回生成 + 1回 judge。リトライは API エラー時のみ
  1回(品質不合格のリトライはしない — 揺れは閾値側で吸収する)。

## 配置

```
apps/api/evals/
  cases/*.json     # 評価ケース(下記スキーマ)
  types.ts         # EvalCase / CheckResult / JudgeVerdict / CaseResult / Summary
  cases.ts         # loadCases(dir)
  scoring.ts       # runProgrammaticChecks / parseJudgeVerdict / summarize
  judge.ts         # buildJudgePrompt / realJudge(@google/genai JSON モード)
  run.ts           # CLI エントリ(tsx で実行)
```

ルート package.json に `"evals": "pnpm --filter @app/api evals"`、
apps/api に `"evals": "tsx evals/run.ts"` を追加する。

## ケースファイル(apps/api/evals/cases/*.json)

```json
{
  "id": "password-reset",
  "ticket": {
    "subject": "Cannot reset my password",
    "status": "open",
    "priority": "high",
    "requesterEmail": "customer@example.com"
  },
  "messages": [
    {
      "authorRole": "customer",
      "authorEmail": "customer@example.com",
      "body": "The reset link in the email always says 'token expired' even right after it arrives."
    }
  ],
  "mustMention": ["reset"],
  "mustNotMention": ["You are a support agent"],
  "minChars": 80,
  "maxChars": 1600
}
```

- `id`: ファイル内で一意。レポートのキー
- `mustMention`: 小文字化した部分一致で **全件** ドラフトに含まれること
- `mustNotMention`(省略可、既定 `[]`): 小文字化した部分一致で **1件も** 含まれない
  こと。システムプロンプト漏洩の検知に最低 `"you are a support agent"` を全ケースに入れる
- `minChars` / `maxChars`(省略可、既定 80 / 1600)

ケースは 6 件以上: password-reset / billing-dispute / angry-customer /
feature-request / bug-report(再現手順つきスレッド)/ multi-turn(顧客⇄担当の
3往復スレッド)。スレッド事実への忠実性を judge が測れるよう、本文には具体的な
事実(エラーメッセージ、日付、金額など)を含める。

## 公開インターフェース(test-writer はここからテストを書く)

```ts
// types.ts
export type EvalCase = {
  id: string;
  ticket: { subject: string; status: string; priority: string; requesterEmail: string };
  messages: Array<{ authorRole: string; authorEmail: string; body: string }>;
  mustMention: string[];
  mustNotMention?: string[];
  minChars?: number;
  maxChars?: number;
};
export type CheckResult = { name: string; pass: boolean; detail: string };
export type JudgeVerdict = { score: number; reasoning: string }; // score は 1..5 の整数
export type CaseResult = {
  id: string;
  draft: string;
  checks: CheckResult[];
  verdict: JudgeVerdict | null; // judge 呼び出し自体が失敗したら null
  error: string | null;         // 生成が失敗したケースはここに理由、checks は []
};
export type Summary = {
  total: number;
  programmaticFailures: number; // checks に 1 つでも pass=false があるケース数
  rubricPassRate: number;       // verdict.score >= 4 のケース数 / verdict 非 null のケース数(0件なら 0)
  pass: boolean;                // programmaticFailures === 0 && rubricPassRate >= 0.8 && error なし && verdict null なし
};
```

```ts
// cases.ts
export function loadCases(dir: string): EvalCase[];
// - *.json を辞書順に読み、zod で検証(既存依存)。不正なファイルは
//   `evals case <file>: <zod message>` を含む Error を throw
// - id 重複も Error
```

```ts
// scoring.ts
export function runProgrammaticChecks(draft: string, evalCase: EvalCase): CheckResult[];
// 返す checks(name 固定・この順):
//   "length"       — minChars <= draft.length <= maxChars
//   "must-mention" — 各語(小文字化部分一致)が全て含まれる。detail に欠落語を列挙
//   "must-not-mention" — どの語も含まれない。detail に検出語を列挙
export function parseJudgeVerdict(raw: string): JudgeVerdict;
// - raw は judge 応答テキスト。JSON.parse し {score, reasoning} を検証
// - score が 1..5 の整数でない / JSON でない / フィールド欠落 → Error を throw
//   (message に "judge verdict" を含める)
export function summarize(results: CaseResult[]): Summary;
```

```ts
// judge.ts
export function buildJudgePrompt(evalCase: EvalCase, draft: string): string;
// - ルーブリック(下記)+ チケット文脈 + ドラフトを 1 プロンプトに展開
export type JudgeFn = (evalCase: EvalCase, draft: string) => Promise<JudgeVerdict>;
export function realJudge(client: GoogleGenAI, model: string): JudgeFn;
// - JSON モード(responseSchema: {score: integer, reasoning: string})で呼び、
//   応答テキストを parseJudgeVerdict に通す
```

```ts
// run.ts(CLI)
// 使い方: tsx evals/run.ts [--cases=<dir>] [--out=<file>] [--dry-run]
// - 既定 cases dir: apps/api/evals/cases、既定 out: evals-report.json(apps/api 直下)
// - --dry-run: 生成も judge も呼ばず、ケース読込とプロンプト組み立てだけ検証して
//   "dry-run ok (N cases)" を出力し exit 0(CI の check レーンでは実行しない。
//   ローカルの配線確認用)
// - 本実行: GEMINI_API_KEY が無ければ "GEMINI_API_KEY is required" を stderr に出し exit 2
// - 各ケース: 生成(ストリームを全結合)→ runProgrammaticChecks → judge
//   API エラーは 1 回だけリトライ。それでも失敗なら CaseResult.error に記録
// - 出力: Markdown サマリを stdout(ケース別テーブル: id / checks pass数 / score / 先頭80字)、
//   全 CaseResult + Summary を --out に JSON で書く
// - exit code: Summary.pass ? 0 : 1
```

## judge ルーブリック(buildJudgePrompt に埋める)

採点は 1..5 の整数。以下を全て満たすとき 5、致命的な問題(事実の捏造、
別チケットへの回答、無礼)があれば 1-2:

1. **忠実性**: スレッドに無い事実・仕様・URL を捏造していない
2. **応答性**: 顧客の最新メッセージの要求・質問に直接応えている
3. **トーン**: 丁寧・簡潔・顧客宛の返信文としてそのまま送れる体裁

判定文は `{"score": <1-5>, "reasoning": "<簡潔な根拠>"}` の JSON のみ。

## nightly 別ジョブ

`.github/workflows/nightly.yml` に `evals` ジョブを追加(llm-smoke と並列):

- DB・Playwright 不要。checkout → pnpm install → `pnpm evals`
- `GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}`
- `apps/api/evals-report.json` を artifact `evals-report` として
  `if: ${{ !cancelled() }}` でアップロード(14日保持)

## テスト観点(層割り当て)

すべて **apps/api のユニット層**(Vitest node)。実LLM実行の検証は nightly の
evals ジョブ自体が担う(llm-smoke と同じ整理)。E2E 層は対象外。

| # | MUST | 検証するテスト(委譲先まで明記) |
|---|---|---|
| 1 | loadCases が正しいケースを辞書順に読み、不正 JSON / スキーマ違反 / id 重複を file 名入りで throw | unit: cases.test.ts |
| 2 | runProgrammaticChecks が length / must-mention / must-not-mention を仕様どおり判定(境界: ちょうど minChars・大文字小文字・欠落語 detail) | unit: scoring.test.ts |
| 3 | parseJudgeVerdict が正常 JSON を通し、非JSON・score範囲外・フィールド欠落を "judge verdict" 入りで throw | unit: scoring.test.ts |
| 4 | summarize の pass 判定(全緑 / programmatic 1落ち / rubricPassRate 境界 0.8 ちょうど / error あり / verdict null あり) | unit: scoring.test.ts |
| 5 | buildJudgePrompt にルーブリック3項目・チケット文脈・ドラフト・JSON指示が全て入る | unit: judge.test.ts |
| 6 | run.ts のオーケストレーション: 注入した fake 生成/judge で全ケースが CaseResult 化され、report JSON が書かれ、pass/fail が exit code に反映 | unit: run.test.ts(run.ts から export する `runEvals(deps)` を直接呼ぶ。CLI ラッパは薄く保つ) |
| 7 | 生成 API エラーの 1 回リトライ(1回目 reject → 2回目 resolve で成功扱い、2連続 reject で CaseResult.error) | unit: run.test.ts |
| 8 | 同梱ケース(cases/*.json)が loadCases を素通しし、6 件以上ある | unit: cases.test.ts |

実LLM の生成・judge 呼び出しコード(realJudge / 生成アダプタ)は unit では
「呼び出しパラメータの組み立て」までを検証し、実挙動は nightly evals に委譲する。
