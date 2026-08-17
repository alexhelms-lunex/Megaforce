"use client";

import { toast } from "sonner";

/**
 * Calling a server action from a button, without the page falling over.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every action handler in this application was written the same way:
 *
 *     start(async () => {
 *       const result = await someAction(...)
 *       if (result.error) toast.error(result.error)
 *       else router.refresh()
 *     })
 *
 * That handles the action REFUSING. It does not handle the action REJECTING,
 * and those are different things. A refusal is a value; a rejection is a
 * thrown error inside a React transition, and React sends it to the nearest
 * error boundary -- which replaces the whole screen with "This page did not
 * load" and a message Next redacts in production.
 *
 * So pressing Save on the user form, when anything at all went wrong on the
 * way to the server, destroyed the page instead of showing a message. The
 * cause was invisible and the form's contents were gone. That is a far worse
 * outcome than any underlying error deserved, and it was one missing try/catch
 * away in nine separate places.
 *
 * One helper, used everywhere, so the tenth cannot be written without it.
 * Every failure becomes a toast; the screen is never destroyed by one.
 * ---------------------------------------------------------------------------
 */

export interface ActionResult {
  // `boolean` rather than `true`: some actions were written returning
  // `{ ok: released.length > 0 }`, and a helper that only accepts the literal
  // would force those to be rewritten for no gain.
  ok?: boolean;
  error?: string;
  message?: string;
  /** Returned by the actions that mint a password, shown once. */
  password?: string;
}

/**
 * Run a server action and report the outcome.
 *
 * Returns the result on success and null on failure, so a caller can do more
 * work afterwards without repeating the check.
 */
export async function runAction<T extends ActionResult>(
  action: () => Promise<T>,
  options: {
    /** Shown when the action succeeds and returns no message of its own. */
    success?: string;
    /** Prefixed to a rejection, so the toast says which button it came from. */
    label?: string;
    /** Suppress the success toast; the caller is showing its own feedback. */
    quiet?: boolean;
  } = {},
): Promise<T | null> {
  const { success, label = "That did not work", quiet = false } = options;

  let result: T;
  try {
    result = await action();
  } catch (err) {
    // A rejected server action. Left uncaught this destroys the page, so the
    // message is worth showing even in its raw form -- it is the only thing
    // anybody gets to see.
    const shown = describe(err);
    if (REDACTED.test(shown)) {
      const real = await realCause();
      toast.error(real ? `${label}: ${real}` : `${label}: ${shown}`);
    } else {
      toast.error(`${label}: ${shown}`);
    }
    return null;
  }

  if (result?.error) {
    toast.error(result.error);
    return null;
  }

  if (result?.password) {
    // Shown once and stored nowhere this screen can read back, so it stays up
    // long enough to be written down.
    toast.success(`${result.message ?? success ?? "Done."} Password: ${result.password}`, {
      duration: 30_000,
    });
    return result;
  }

  if (!quiet) toast.success(result?.message ?? success ?? "Saved.");
  return result;
}

/** Next's stand-in for a server error it will not repeat in production. */
const REDACTED = /omitted in production|Server Components render|digest property/i;

/**
 * Go and get the message production just refused to show.
 *
 * ---------------------------------------------------------------------------
 * Next redacts server errors, and the reasoning is sound -- an unhandled error
 * can carry a connection string. The consequence was that every failure in this
 * application looked identical from the outside, and each one cost a round trip
 * to diagnose: a screenshot, a guess, a deploy, another screenshot. Some took
 * three. One of them took three weeks.
 *
 * The real message is already captured server-side by the onRequestError hook
 * in instrumentation.ts, before any redaction. It was readable at /api/errors
 * -- by an administrator who thought to go and look, which is not a thing
 * anybody thinks to do while a button is not working.
 *
 * So the toast fetches it itself. The person who pressed the button sees what
 * actually happened, in the same second, without being told to open a
 * developer tool. The endpoint stays admin-only and a 404 simply leaves the
 * redacted message in place, so this widens nothing.
 * ---------------------------------------------------------------------------
 */
async function realCause(): Promise<string | null> {
  try {
    const res = await fetch("/api/errors", { cache: "no-store" });
    if (!res.ok) return null;

    const body = (await res.json()) as { errors?: { at?: string; message?: string }[] };
    const newest = body.errors?.[0];
    if (!newest?.message || !newest.at) return null;

    // Only if it belongs to the button that was just pressed. These are held
    // per server instance, so the newest one can easily be a minute-old
    // failure from a different screen -- and attaching that to this click
    // would be worse than the redaction it replaced.
    const age = Date.now() - Date.parse(newest.at);
    if (!(age >= 0 && age < 30_000)) return null;

    return newest.message;
  } catch {
    // Offline, or not an administrator. Either way the redacted message stands.
    return null;
  }
}

/**
 * Unwrap the real reason behind a thrown error.
 *
 * Node's fetch reports nearly every network problem as the single word "fetch
 * failed" and hides the actual cause one level down in `cause`.
 */
function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (e.message && !parts.includes(e.message)) parts.push(e.message);
    current = e.cause;
  }
  return parts.join(" — ") || String(err);
}
