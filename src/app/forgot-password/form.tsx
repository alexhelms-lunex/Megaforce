"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset } from "./actions";

/**
 * Asking for a reset link.
 *
 * The confirmation deliberately does not say whether the address exists -- see
 * the action for why. It reads as a plain statement of what was done, which is
 * also the truthful version: a link was sent to that address if there is an
 * account behind it.
 */
export function ForgotPasswordForm() {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  if (sent) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/60">
          <p className="font-medium text-emerald-900 dark:text-emerald-200">Check your email</p>
          <p className="mt-1 text-emerald-800 dark:text-emerald-300">
            If there is an account for <span className="font-medium">{address}</span>, a link to
            set a new password is on its way. It expires in an hour.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Nothing arriving? Check the spam folder, then try again in a few minutes — there is a
          limit on how often reset emails can be sent to one address.
        </p>
        <Button variant="outline" className="w-full" onClick={() => setSent(false)}>
          Use a different address
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
        setAddress(String(form.get("email") ?? ""));
        setError(null);
        start(async () => {
          // No runAction here: this screen is reached WITHOUT a session, and
          // runAction's fallback fetches /api/errors, which correctly refuses
          // anybody who is not a signed-in administrator.
          try {
            const result = await requestPasswordReset(form);
            if (result.error) setError(result.error);
            else setSent(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "That did not work. Try again.");
          }
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="email">Your email address</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          placeholder="you@company.com"
        />
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Email me a reset link"}
      </Button>

      <p className="text-center text-sm">
        <Link href="/login" className="text-muted-foreground hover:text-foreground hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
