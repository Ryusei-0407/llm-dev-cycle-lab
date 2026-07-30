import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases } from "../evals/cases.js";

// evals (spec: specs/evals.md) MUST 1 & 8: loadCases(dir) reads cases/*.json in
// lexicographic filename order, validates each file with zod, and throws with
// the offending file name for invalid JSON / schema violations / duplicate ids.
// Fixtures are generated under os.tmpdir() inside the tests — no fixture files
// live in the repository. MUST 8 runs the bundled apps/api/evals/cases directory
// through the same loader (RED until the implementer adds the case files).

const createdDirs: string[] = [];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-cases-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validCase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ticket: {
      subject: "Cannot reset my password",
      status: "open",
      priority: "high",
      requesterEmail: "customer@example.com",
    },
    messages: [
      {
        authorRole: "customer",
        authorEmail: "customer@example.com",
        body: "The reset link says 'token expired' right after it arrives.",
      },
    ],
    mustMention: ["reset"],
    mustNotMention: ["You are a support agent"],
    minChars: 80,
    maxChars: 1600,
    ...overrides,
  };
}

function writeCase(dir: string, fileName: string, data: unknown): void {
  writeFileSync(join(dir, fileName), JSON.stringify(data, null, 2));
}

describe("loadCases", () => {
  it(
    "*.json を辞書順(ファイル名順)に読み込む",
    {
      annotation: {
        type: "description",
        description:
          "ケースディレクトリの *.json がファイル名の辞書順で読み込まれ、EvalCase の配列として返ることを検証",
      },
    },
    () => {
      const dir = fixtureDir();
      // File names deliberately disagree with ids so ordering by filename is
      // distinguishable from ordering by id.
      writeCase(dir, "20-second.json", validCase("zulu"));
      writeCase(dir, "10-first.json", validCase("alpha"));
      writeCase(dir, "30-third.json", validCase("mike"));
      const cases = loadCases(dir);
      expect(cases.map((c) => c.id)).toEqual(["alpha", "zulu", "mike"]);
    },
  );

  it(
    ".json 以外のファイルは無視する",
    {
      annotation: {
        type: "description",
        description:
          "ケースディレクトリに *.json 以外のファイルが混在しても無視され、JSON ケースだけが読み込まれることを検証",
      },
    },
    () => {
      const dir = fixtureDir();
      writeCase(dir, "only.json", validCase("only"));
      writeFileSync(join(dir, "notes.txt"), "not a case");
      const cases = loadCases(dir);
      expect(cases.map((c) => c.id)).toEqual(["only"]);
    },
  );

  it(
    "JSON として不正なファイルはファイル名入りの Error を throw する",
    {
      annotation: {
        type: "description",
        description:
          "パース不能な JSON を含むケースファイルで loadCases が throw し、メッセージに当該ファイル名が含まれることを検証",
      },
    },
    () => {
      const dir = fixtureDir();
      writeCase(dir, "ok.json", validCase("ok"));
      writeFileSync(join(dir, "broken.json"), "{ this is not json");
      expect(() => loadCases(dir)).toThrowError(/broken\.json/);
    },
  );

  it(
    "スキーマ違反(mustMention 欠落)は 'evals case <file>' 入りの Error を throw する",
    {
      annotation: {
        type: "description",
        description:
          "必須フィールド mustMention を欠くケースファイルで loadCases が throw し、メッセージに 'evals case' とファイル名が含まれることを検証",
      },
    },
    () => {
      const dir = fixtureDir();
      const invalid = validCase("bad");
      delete invalid.mustMention;
      writeCase(dir, "missing-must-mention.json", invalid);
      const load = () => loadCases(dir);
      expect(load).toThrowError(/evals case/);
      expect(load).toThrowError(/missing-must-mention\.json/);
    },
  );

  it(
    "スキーマ違反(ticket.subject の型不一致)もファイル名入りで throw する",
    {
      annotation: {
        type: "description",
        description:
          "ticket.subject が文字列でないケースファイルで loadCases が throw し、メッセージにファイル名が含まれることを検証",
      },
    },
    () => {
      const dir = fixtureDir();
      const invalid = validCase("bad-ticket", {
        ticket: {
          subject: 42,
          status: "open",
          priority: "high",
          requesterEmail: "customer@example.com",
        },
      });
      writeCase(dir, "bad-ticket.json", invalid);
      expect(() => loadCases(dir)).toThrowError(/bad-ticket\.json/);
    },
  );

  it(
    "id 重複は Error を throw する",
    {
      annotation: {
        type: "description",
        description:
          "異なる2ファイルが同じ id を持つとき loadCases が Error を throw することを検証(レポートキーの一意性)",
      },
    },
    () => {
      const dir = fixtureDir();
      writeCase(dir, "a.json", validCase("dup-id"));
      writeCase(dir, "b.json", validCase("dup-id"));
      expect(() => loadCases(dir)).toThrowError();
    },
  );
});

describe("bundled eval cases", () => {
  it(
    "同梱ケース(evals/cases)が loadCases を素通しし 6 件以上ある",
    {
      annotation: {
        type: "description",
        description:
          "リポジトリ同梱の apps/api/evals/cases が loadCases のスキーマ検証を全件通過し、仕様の6シナリオ以上が揃っていることを検証",
      },
    },
    () => {
      const bundledDir = fileURLToPath(new URL("../evals/cases", import.meta.url));
      const cases = loadCases(bundledDir);
      expect(cases.length).toBeGreaterThanOrEqual(6);
      const ids = cases.map((c) => c.id);
      // Spec-mandated scenario set (specs/evals.md「ケースは 6 件以上」).
      for (const required of [
        "password-reset",
        "billing-dispute",
        "angry-customer",
        "feature-request",
        "bug-report",
        "multi-turn",
      ]) {
        expect(ids).toContain(required);
      }
      // Spec: every case carries the system-prompt-leak guard phrase.
      for (const evalCase of cases) {
        const guards = (evalCase.mustNotMention ?? []).map((w) => w.toLowerCase());
        expect(
          guards.some((w) => w.includes("you are a support agent")),
          `case ${evalCase.id} must include the "you are a support agent" leak guard`,
        ).toBe(true);
      }
    },
  );
});

// 敵対的レビューの反証固定(@pinned 相当)。いずれもレビューが実行再現した
// 反例をテスト資産化したもの — 実装側の修正(cases.ts)を殺すミューテーション
// から守る。
describe("loadCases pinned counterexamples", () => {
  it("*.json 名のディレクトリ(I/O エラー)もファイル名入りで throw する", () => {
    const dir = fixtureDir();
    // readFileSync が EISDIR を投げる攻撃入力。try 外にあると生のエラーが漏れる。
    mkdirSync(join(dir, "trap.json"));
    writeCase(dir, "ok.json", validCase("ok"));
    expect(() => loadCases(dir)).toThrowError(/evals case trap\.json:/);
  });

  it('空文字列の mustMention 語は schema で弾く(includes("") 常時 true の抜け穴)', () => {
    const dir = fixtureDir();
    writeCase(dir, "empty-term.json", validCase("empty-term", { mustMention: [""] }));
    expect(() => loadCases(dir)).toThrowError(/evals case empty-term\.json:/);
  });

  it("空文字列の mustNotMention 語も同様に弾く", () => {
    const dir = fixtureDir();
    writeCase(dir, "empty-forbid.json", validCase("empty-forbid", { mustNotMention: [""] }));
    expect(() => loadCases(dir)).toThrowError(/evals case empty-forbid\.json:/);
  });

  it("minChars > maxChars(length が永久 fail する設定ミス)を弾く", () => {
    const dir = fixtureDir();
    writeCase(dir, "bounds.json", validCase("bounds", { minChars: 500, maxChars: 100 }));
    expect(() => loadCases(dir)).toThrowError(
      /evals case bounds\.json: minChars must be <= maxChars/,
    );
  });

  it("既定値との組み合わせでも bounds を検証する(minChars 2000 + maxChars 省略)", () => {
    const dir = fixtureDir();
    const noMax = validCase("no-max", { minChars: 2000 });
    delete noMax.maxChars;
    writeCase(dir, "no-max.json", noMax);
    expect(() => loadCases(dir)).toThrowError(
      /evals case no-max\.json: minChars must be <= maxChars/,
    );
  });
});
