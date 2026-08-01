import { createFileRoute, redirect, useLoaderData } from "@tanstack/react-router";
import { App } from "@/App";
import { fetchMe } from "@/auth/api";
import { AppShell } from "@/components/app-shell";

// Auth guard: resolve the session before the protected home renders. Loading in
// beforeLoad (not the component) means an unauthenticated visitor is redirected
// to /login before any protected UI mounts (specs/auth.md).
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: Home,
});

function Home() {
  const { user } = useLoaderData({ from: "/" });
  return (
    <AppShell user={user}>
      <App />
    </AppShell>
  );
}
