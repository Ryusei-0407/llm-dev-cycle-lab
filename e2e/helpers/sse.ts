/**
 * page.route モック用に /api/chat のワイヤフォーマットどおりのSSEボディを組み立てる。
 *
 * 制約: route.fulfill() はボディを一括送信するため、「逐次描画」は再現できない。
 * 逐次描画の検証は Vitest Browser Mode(apps/web/test-browser/)と
 * @backend テストが担当する。
 */
export function sseBody(
  deltas: string[],
  opts: { done?: boolean; errorAfter?: boolean } = {},
): string {
  const { done = true, errorAfter = false } = opts;
  let body = deltas
    .map((delta) => `data: ${JSON.stringify({ delta })}\n\n`)
    .join('');
  if (errorAfter) body += `data: ${JSON.stringify({ error: 'stream_failed' })}\n\n`;
  else if (done) body += 'data: [DONE]\n\n';
  return body;
}
