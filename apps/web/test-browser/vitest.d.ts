// Browser-mode tests carry the Japanese `description` annotation (POLICY.md
// §共通規約) via the test(name, options, fn) form. Vitest accepts the extra
// option at runtime but does not type it, so we merge `annotation` into
// TestOptions — the same shim apps/api/test/vitest.d.ts uses.
import "@vitest/runner";

declare module "@vitest/runner" {
  interface TestOptions {
    annotation?: {
      type: string;
      description: string;
    };
  }
}
