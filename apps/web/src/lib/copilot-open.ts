import { useSyncExternalStore } from "react";

// copilot (spec: specs/copilot.md): the dock must stay open across route
// changes. Each protected route renders its own <AppShell>, so a route
// navigation remounts the shell and would reset a plain useState. Keeping the
// open flag in a module-level store (read via useSyncExternalStore) lets the
// freshly-mounted shell pick up the same value, so the panel survives the jump
// from a SUP-n reference to the ticket detail.
let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setCopilotOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleCopilotOpen(): void {
  setCopilotOpen(!open);
}

export function useCopilotOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => open,
  );
}
