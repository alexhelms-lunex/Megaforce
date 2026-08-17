"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";

export interface ClaimResult {
  ok?: true;
  error?: string;
}

/**
 * Take an unowned account.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE BODY IS INSIDE A try/catch
 *
 * This action threw, and the button reported: "An error occurred in the Server
 * Components render. The specific message is omitted in production builds to
 * avoid leaking sensitive details."
 *
 * That is Next.js redacting an error that escapes a server action. The
 * redaction is correct -- an unhandled error can carry a connection string --
 * but it means an action that throws is undiagnosable from the outside, and no
 * amount of reading the code narrows it down.
 *
 * An error CAUGHT inside the action and returned as an ordinary value is not
 * redacted, because it is data rather than a crash. So nothing escapes from
 * here: every failure comes back as a sentence, on screen, naming what actually
 * happened.
 *
 * Two things were removed from this path rather than diagnosed, because
 * neither earns its risk in a two-statement action:
 *
 *   pino. It pulls a logging framework into a serverless action to write one
 *   line. console does the same job -- Vercel captures it identically -- with
 *   nothing to initialise and nothing to fail.
 *
 *   An unguarded revalidatePath. Three calls, one of them a dynamic path.
 *   Cache invalidation failing is a stale screen; it is not a reason to tell
 *   somebody their claim did not work when the row has already changed hands.
 *
 * The claim stays race-safe throughout. `.is("owner_id", null)` is part of the
 * UPDATE, so two brokers pressing at the same instant produce one winner and
 * one honest refusal -- the database decides, not a check-then-write here.
 * ---------------------------------------------------------------------------
 */
export async function claim(formData: FormData): Promise<ClaimResult> {
  try {
    const accountId = String(formData.get("accountId") ?? "");
    if (!accountId) return { error: "No account given." };

    const user = await currentUser();
    if (!user) return { error: "Not signed in. Reload the page and sign in again." };

    const supabase = await createClient();

    const { data, error } = await supabase
      .from("accounts")
      // The release reason is cleared in the same statement. Left behind, an
      // account claimed out of the pool still reads "went quiet, timed out" as
      // its reason for being free -- describing the LAST holder's failure on a
      // record that now belongs to somebody else.
      .update({ owner_id: user.id, last_release_reason: null })
      .eq("id", accountId)
      .is("owner_id", null)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[claim] failed", { accountId, by: user.id, message: error.message });
      return { error: friendly(error.message) };
    }

    if (!data) {
      // The update matched nothing: either it is gone, or somebody got there
      // first. Naming the winner ends the matter; "could not claim" invites a
      // second click and then a support message.
      const { data: current } = await supabase
        .from("accounts_with_state")
        .select("owner_name")
        .eq("id", accountId)
        .maybeSingle();

      if (!current) return { error: "That account no longer exists." };
      return {
        error: current.owner_name
          ? `${current.owner_name} claimed this one first.`
          : "Somebody claimed this a moment before you did.",
      };
    }

    refresh(accountId);
    return { ok: true };
  } catch (err) {
    console.error("[claim] threw", err);
    return { error: `Claim failed: ${describe(err)}` };
  }
}

/**
 * Give an account back.
 *
 * Only the current owner, an admin, or credit may. The database enforces it
 * too -- the ownership trigger refuses a broker releasing somebody else's
 * account -- so this check exists to produce a sentence rather than a
 * constraint violation.
 */
export async function release(formData: FormData): Promise<ClaimResult> {
  try {
    const accountId = String(formData.get("accountId") ?? "");
    if (!accountId) return { error: "No account given." };

    const user = await currentUser();
    if (!user) return { error: "Not signed in. Reload the page and sign in again." };

    const supabase = await createClient();

    const { data: account, error: readError } = await supabase
      .from("accounts")
      .select("owner_id")
      .eq("id", accountId)
      .maybeSingle();

    if (readError) return { error: friendly(readError.message) };
    if (!account) return { error: "That account no longer exists." };

    const privileged = user.role === "admin" || user.role === "credit";
    if (account.owner_id !== user.id && !privileged) {
      return { error: "You can only release an account you hold." };
    }

    // last_release_reason is set in the same statement so the trigger that
    // closes the claim record can read it. Setting it afterwards would file the
    // release under a guessed reason.
    const { error } = await supabase
      .from("accounts")
      .update({ owner_id: null, last_release_reason: "manual" })
      .eq("id", accountId);

    if (error) {
      console.error("[release] failed", { accountId, by: user.id, message: error.message });
      return { error: friendly(error.message) };
    }

    refresh(accountId);
    return { ok: true };
  } catch (err) {
    console.error("[release] threw", err);
    return { error: `Release failed: ${describe(err)}` };
  }
}

/**
 * Invalidate the screens this changes, without letting that failure count as
 * the action failing. The row has already moved by the time this runs.
 */
function refresh(accountId: string): void {
  for (const path of ["/", "/available", "/accounts", `/accounts/${accountId}`]) {
    try {
      revalidatePath(path);
    } catch {
      // A stale cache entry is a page one refresh away from being right.
    }
  }
}

/**
 * Unwrap the real reason behind a thrown error.
 *
 * Node's fetch reports nearly every network problem as the single word "fetch
 * failed" and hides the actual cause one level down in `cause`. Reporting only
 * the top-level message leaves somebody staring at two words that describe
 * every possible failure equally.
 */
function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; code?: string; cause?: unknown };
    const piece = [e.message, e.code && e.code !== e.message ? `(${e.code})` : null]
      .filter(Boolean)
      .join(" ");
    if (piece && !parts.includes(piece)) parts.push(piece);
    current = e.cause;
  }
  return parts.join(" — ") || String(err);
}

/**
 * Postgres speaks to developers. This screen speaks to brokers.
 *
 * The two cases worth translating are the ownership trigger and a missing
 * table, because the first is a rule somebody needs explaining and the second
 * means the database is behind the code -- which is an administrator's problem,
 * not a broker's, and saying so saves an hour of confusion.
 */
function friendly(message: string): string {
  if (/only be changed by an admin|belongs to another broker/i.test(message)) {
    return "That account belongs to another broker. Only an admin can move it.";
  }
  if (/does not exist|schema cache|could not find/i.test(message)) {
    return (
      "The database is missing something this build expects. An administrator needs to " +
      `re-run setup to apply the latest migrations. (${message})`
    );
  }
  if (/row-level security|permission denied/i.test(message)) {
    return "You do not have permission to change that account.";
  }
  return message;
}
