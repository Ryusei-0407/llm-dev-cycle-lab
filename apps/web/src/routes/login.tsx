import { createFileRoute, useRouter } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { login } from "@/auth/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await login(email, password);
    if (result.ok) {
      // Re-run the guard so the now-valid session is seen, then land on /.
      await router.invalidate();
      await router.navigate({ to: "/" });
      return;
    }
    setError("メールアドレスまたはパスワードが正しくありません");
    setSubmitting(false);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <h1 className="mb-1 text-lg font-semibold tracking-tight">サポートデスク</h1>
        <p className="mb-6 text-sm text-muted-foreground">サインインして続行</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Email</span>
            <Input
              type="email"
              aria-label="Email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Password</span>
            <Input
              type="password"
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div
              role="alert"
              data-testid="login-error"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <Button type="submit" disabled={submitting}>
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
