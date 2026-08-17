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
 * In memory, deliberately: these are for the ten minutes after something
 * breaks, not for an audit trail. Writing them to the database would mean a
 * write on the very path that is already failing, and a serverless instance
 * that has just crashed is not the place to be starting transactions.
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

  // Also to stdout, which Vercel captures — so it is in the logs even if the
  // instance serving /api/errors is a different one.
  console.error("[megaforce] request failed", captured);

  const store = (globalThis.__megaforceErrors ??= []);
  store.unshift(captured);
  if (store.length > LIMIT) store.length = LIMIT;
};
