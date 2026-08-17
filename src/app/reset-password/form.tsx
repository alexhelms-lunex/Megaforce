"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, checkPassword, passwordStrength } from "@/lib/password";
import { setNewPassword } from "./actions";

/**
 * Choosing the new password.
 *
 * The rules are checked here as you type AND on the server. The client copy is
 * there so nobody submits a form to be told it was too short; the server copy
 * is the one that decides, because the client one is a suggestion anybody can
 * skip.
 */
export function ResetPasswordForm({ email }: { email: string | null }) {
  const [pending, start] = useTransition();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();

  const strength = passwordStrength(password);
  const localProblem = password ? checkPassword(password) : null;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length > 0 && !localProblem && !mismatch && confirm.length > 0;

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/60">
          <p className="font-medium text-emerald-900 dark:text-emerald-200">Password changed</p>
          <p className="mt-1 text-emerald-800 dark:text-emerald-300">
            You are signed in. Any other device that was signed in as you will need the new
            password.
          </p>
        </div>
        <Button className="w-full" onClick={() => router.push("/")}>
          Go to the CRM
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setError(null);
        start(async () => {
          try {
            const result = await setNewPassword(form);
            if (result.error) setError(result.error);
            else setDone(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "That did not work. Try again.");
          }
        });
      }}
    >
      {email ? (
        <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
          Setting a new password for <span className="font-medium text-foreground">{email}</span>
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {/* Four segments rather than a percentage. A number invites arguing
            with it; four steps read as a direction to move in. */}
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  strength.score >= step
                    ? step === 3
                      ? "bg-emerald-500"
                      : step === 2
                        ? "bg-amber-500"
                        : "bg-orange-500"
                    : "bg-muted"
                }`}
              />
            ))}
          </div>
          <span className="w-20 text-right text-xs text-muted-foreground">{strength.label}</span>
        </div>

        <p className="text-xs text-muted-foreground">
          At least {MIN_PASSWORD_LENGTH} characters. A phrase of three or four words is easier to
          remember and harder to guess than a short word with a symbol on the end.
        </p>
        {localProblem ? <p className="text-xs text-destructive">{localProblem}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">Type it again</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch ? <p className="text-xs text-destructive">These do not match.</p> : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending || !ready}>
        {pending ? "Saving…" : "Set my new password"}
      </Button>

      <p className="text-center text-sm">
        <Link href="/login" className="text-muted-foreground hover:text-foreground hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
