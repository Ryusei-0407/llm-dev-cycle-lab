// The tickets store integration test tags each case with a Japanese
// `description` annotation (POLICY.md §共通規約) via the it(name, options, fn)
// form. Vitest accepts the extra option at runtime but does not type it, so we
// merge `annotation` into TestOptions here. Keeps the test file untouched while
// `pnpm check` stays green.
import "@vitest/runner";

declare module "@vitest/runner" {
  interface TestOptions {
    annotation?: {
      type: string;
      description: string;
    };
  }
}
