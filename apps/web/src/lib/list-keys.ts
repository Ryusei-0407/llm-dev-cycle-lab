// キーボード一覧操作の純ロジック(spec: specs/keyboard-nav.md 公開インターフェース)。
// document keydown ハンドラ本体は route 側に置き、ここには DOM 非依存の判定だけを
// 切り出す — unit レーンで網羅し、route/TicketList 側はこの結果を使うだけにする。

// 次のアクティブ index。current が null(未選択)なら delta の向きに関わらず 0。
// 0..count-1 にクランプ。count === 0 なら null。
export function nextActiveIndex(
  current: number | null,
  delta: 1 | -1,
  count: number,
): number | null {
  if (count === 0) return null;
  if (current === null) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > count - 1) return count - 1;
  return next;
}

// keydown を無視すべきターゲットか(input/textarea/select/contenteditable)。
// contenteditable は isContentEditable で見る — 属性値の "true"/"" と継承の両方を
// ブラウザが解決した結果を使う。
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
