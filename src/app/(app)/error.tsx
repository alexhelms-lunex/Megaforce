"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertOctagon, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * What a broken page looks like.
 *
 * The default is a white screen reading "Application error: a server-side
 * exception has occurred" and a digest number, which tells the person looking
 * at it nothing at all and tells whoever they report it to almost nothing.
 *
 * This says three things instead: what probably went wrong, what to try, and
 * the digest in a form somebody can copy. The commonest cause by a distance is
 * a database that has not had the latest migrations applied -- the code expects
 * a column the database has not got -- so that gets named explicitly rather
 * than left to be guessed at.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side digests are opaque in the browser by design. Logging what we
    // do have makes the browser console useful when the server logs are not to
    // hand.
    console.error("Megaforce page error", { message: error.message, digest: error.digest });
  }, [error]);

  const looksLikeSchema = /column|relation|does not exist|schema cache|function/i.test(
    error.message,
  );

  return (
    <div className="mx-auto max-w-xl py-16">
      <div className="rounded-xl border bg-card p-8">
        <AlertOctagon className="size-7 text-destructive" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">This page did not load</h1>

        <p className="mt-2 text-sm text-muted-foreground">
          {looksLikeSchema
            ? "The database is missing something this version of the app expects. That usually means the latest setup has not been run since the last deploy."
            : "Something failed on the server while building this page."}
        </p>

        {error.message ? (
          <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {error.message}
          </pre>
        ) : null}

        {error.digest ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Reference <span className="font-mono">{error.digest}</span> — quote this if you report it.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={reset}>
            <RotateCw className="size-3.5" aria-hidden />
            Try again
          </Button>
          <Link
            href="/"
            className="inline-flex h-8 items-center rounded-full border px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            Back to the dashboard
          </Link>
          <Link
            href="/admin"
            className="inline-flex h-8 items-center rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent"
          >
            System health
          </Link>
        </div>
      </div>
    </div>
  );
}
