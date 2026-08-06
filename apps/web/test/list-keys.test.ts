import { describe, expect, it } from "vitest";
import { isEditableTarget, nextActiveIndex } from "../src/lib/list-keys";

// Unit tests (node lane — vite.config.ts の project "unit", environment: "node")
// for the pure keyboard-navigation logic (spec: specs/keyboard-nav.md 公開
// インターフェース / テスト観点 unit). nextActiveIndex はアクティブ index の遷移と
// クランプ規則、isEditableTarget は keydown を無視すべき入力系ターゲットの判定を持つ。
// ブラウザ不要の純関数なのでここが最速の検証層。node レーンには DOM が無いため、
// isEditableTarget には実 DOM 要素が標準で公開するプロパティ(tagName は大文字、
// isContentEditable)だけを持つ最小のダック型ターゲットを渡す。実ブラウザでの
// 実 DOM 要素に対する挙動は BM 層(input フォーカス中無効)が担保する。

describe("nextActiveIndex", () => {
  it("未選択(null)から j(+1)は先頭 0 を返す", () => {
    expect(nextActiveIndex(null, 1, 5)).toBe(0);
  });

  it("未選択(null)から k(-1)でも向きに関わらず先頭 0 を返す", () => {
    expect(nextActiveIndex(null, -1, 5)).toBe(0);
  });

  it("先頭 0 で k(-1)は 0 に留まる(クランプ・循環しない)", () => {
    expect(nextActiveIndex(0, -1, 5)).toBe(0);
  });

  it("末尾で j(+1)は末尾に留まる(クランプ)", () => {
    expect(nextActiveIndex(4, 1, 5)).toBe(4);
  });

  it("中間から j(+1)は次の index へ進む", () => {
    expect(nextActiveIndex(2, 1, 5)).toBe(3);
  });

  it("中間から k(-1)は前の index へ戻る", () => {
    expect(nextActiveIndex(2, -1, 5)).toBe(1);
  });

  it("count が 0 のとき null を返す(行が無い)", () => {
    expect(nextActiveIndex(null, 1, 0)).toBeNull();
    expect(nextActiveIndex(0, 1, 0)).toBeNull();
  });

  it("範囲外の current(count 以上)は末尾へクランプする", () => {
    expect(nextActiveIndex(9, 1, 5)).toBe(4);
    expect(nextActiveIndex(9, -1, 5)).toBe(4);
  });
});

// 実 DOM 要素が標準で公開する形の最小ターゲット。tagName は DOM 準拠で大文字、
// contenteditable は isContentEditable(要素は contenteditable="true" のとき true)。
function editableTarget(tagName: string, isContentEditable = false): EventTarget {
  return { tagName, isContentEditable } as unknown as EventTarget;
}

describe("isEditableTarget", () => {
  it("input 要素で true", () => {
    expect(isEditableTarget(editableTarget("INPUT"))).toBe(true);
  });

  it("textarea 要素で true", () => {
    expect(isEditableTarget(editableTarget("TEXTAREA"))).toBe(true);
  });

  it("select 要素で true", () => {
    expect(isEditableTarget(editableTarget("SELECT"))).toBe(true);
  });

  it("contenteditable=true の要素で true", () => {
    expect(isEditableTarget(editableTarget("DIV", true))).toBe(true);
  });

  it("通常の div で false", () => {
    expect(isEditableTarget(editableTarget("DIV"))).toBe(false);
  });

  it("null で false", () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});
