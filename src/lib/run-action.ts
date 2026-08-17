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
    toast.error(`${label}: ${describe(err)}`);
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
