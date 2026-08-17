/**
 * Catching what production hides.
 *
 * ---------------------------------------------------------------------------
 * Next redacts server errors in production. The reasoning is sound -- an
 * unhandled error can carry a connection string -- and the consequence has
 * been that four separate crashes in this application produced the identical,
 * useless page: "An error occurred in the Server Components render. The
 * specific message is omitted in production builds", plus a digest number that
 * refers to nothing anybody can look up.
 *
 * Every one of those took a round trip to diagnose: a screenshot, a guess, a
 * deploy, another screenshot. Some took three.
 *
 * `onRequestError` is Next's hook for exactly this. It receives the REAL error,
 * server-side, before any redaction. This keeps the last few in memory and
 * exposes them to an administrator at /api/errors, so the next time a screen
 * breaks the question "what actually happened" is answered by opening a page
 * rather than by guessing.
 *
 * TWO PLACES, AND THE SECOND ONE IS THE IMPORTANT ONE.
 *
 * In memory, for the instance that failed. And in a table, because Vercel runs
 * many instances and discards them constantly -- so the instance answering
 * "what went wrong" is almost never the instance that went wrong, and a purely
 * in-memory log answered "nothing has failed here" seconds after something
 * had. That answer is worse than no answer: it reads as evidence the error is
 * not real.
 *
 * THIS FILE MUST LIVE IN src/. Next loads it from the project root OR from
 * src/ when a src directory exists -- never both. It sat at the root for
 * several weeks while the application lived in src/app, so it was never
 * compiled into the build and never ran once. The build succeeds either way
 * and nothing warns, which is why boundary.test.ts now asserts its location.
 * ---------------------------------------------------------------------------
 */

export interface CapturedError {
  at: string;
  digest?: string;
  message: string;
  /** The route that failed, e.g. /admin/users/[id]. */
  path?: string;
  /** 'render' for a page, 'action' for a server action. */
  kind?: string;
  stack?: string;
  /** The deployment it happened on, so a crash fixed two deploys ago reads as old. */
  release?: string | null;
}

const LIMIT = 25;

declare global {
  var __megaforceErrors: CapturedError[] | undefined;
}

export function recentErrors(): CapturedError[] {
  return globalThis.__megaforceErrors ?? [];
}

export function clearErrors(): void {
  globalThis.__megaforceErrors = [];
}

export async function register() {
  // Nothing to set up. The hook below is what does the work.
}

export const onRequestError: (
  err: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; routeType?: string },
) => void = (err, request, context) => {
  const e = err as { message?: string; digest?: string; stack?: string };

  const captured: CapturedError = {
    at: new Date().toISOString(),
    digest: e?.digest,
    message: e?.message ?? String(err),
    path: context?.routePath ?? request?.path,
    kind: context?.routeType,
    // Trimmed. The first few frames name the file; the rest is framework
    // internals that have never once helped.
    stack: e?.stack?.split("\n").slice(0, 8).join("\n"),
  };

  // Also to stdout, which Vercel captures.
  console.error("[megaforce] request failed", captured);

  const store = (globalThis.__megaforceErrors ??= []);
  store.unshift(captured);
  if (store.length > LIMIT) store.length = LIMIT;

  void persist(captured);
};

/**
 * Write it somewhere every instance can read.
 *
 * ---------------------------------------------------------------------------
 * The array above is per-instance, and that made it close to useless in
 * production. Vercel runs many serverless instances and discards them
 * constantly, so the instance serving "what went wrong" is almost never the
 * instance that failed -- and /api/errors reliably answered "nothing has failed
 * here", seconds after something had. Which is exactly the answer that keeps a
 * bug alive: it looks like evidence that the error is not real.
 *
 * The table is shared, so it does not have that problem.
 *
 * Fire and forget, and silent on failure. This runs while a request is already
 * failing; an error logger that can itself throw turns one broken screen into
 * two, and there would be nothing left to write the second one down with.
 * ---------------------------------------------------------------------------
 */
async function persist(captured: CapturedError): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  try {
    // Plain fetch rather than supabase-js: this file is loaded before the
    // application is, and a logger is the last place that should be pulling in
    // a client library and whatever it initialises.
    await fetch(`${url}/rest/v1/app_errors`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        at: captured.at,
        digest: captured.digest ?? null,
        message: captured.message,
        path: captured.path ?? null,
        kind: captured.kind ?? null,
        stack: captured.stack ?? null,
        release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      }),
    });
  } catch {
    // The console line above already happened. That is the fallback.
  }
}
