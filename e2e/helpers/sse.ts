// Builds an SSE body matching the /api/chat wire format, for page.route mocks.
// Note: route.fulfill() sends the whole body at once — fine for asserting final
// state, but it cannot reproduce incremental rendering. Incremental streaming
// behaviour is covered by Vitest Browser Mode and the @backend tests.
export function sseBody(
  deltas: string[],
  opts: { done?: boolean; errorAfter?: boolean } = {},
): string {
  const { done = true, errorAfter = false } = opts;
  let body = deltas.map((delta) => `data: ${JSON.stringify({ delta })}\n\n`).join("");
  if (errorAfter) body += `data: ${JSON.stringify({ error: "stream_failed" })}\n\n`;
  else if (done) body += "data: [DONE]\n\n";
  return body;
}
