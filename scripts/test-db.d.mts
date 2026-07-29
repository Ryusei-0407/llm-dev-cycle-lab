// Type declarations for the JS supplier script so TS importers (vitest
// globalSetup, tickets-store.test.ts) get real types instead of implicit any.
export function applySchemaAndSeed(url: string): Promise<void>;
export function provision(): Promise<{ url: string; containerName: string }>;
export function teardown(containerName: string | undefined): Promise<void>;
