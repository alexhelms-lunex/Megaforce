"use server";

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/logger";
import { createClient, currentUser } from "@/lib/supabase/server";

const log = logger.child({ component: "claims" });

export interface ClaimResult {
  ok?: true;
  error?: string;
}

/**
 * Take an unowned account.
 *
 * ---------------------------------------------------------------------------
 * These used to run through Drizzle on the service-role connection. That was a
 * mistake, and it is the mistake that produced a blank "Application error" on
 * the account page: every page in the application reads through the Supabase
 * client, so a missing or wrong DATABASE_URL let everything render perfectly
 * and made exactly these two buttons explode.
 *
 * Two separate connections for user-facing work was never justified. A claim is
 * a user's action on a row they are allowed to touch, so it belongs on the same
 * authenticated client as everything else, with row level security applied
 * rather than bypassed and re-checked by hand.
 *
 * The claim stays race-safe. `.is("owner_id", null)` is part of the UPDATE, so
 * two brokers pressing at the same instant produce one winner and one honest
 * refusal -- the database decides, not a check-then-write in this function.
 * ---------------------------------------------------------------------------
 */
export async function claim(formData: FormData): Promise<ClaimResult> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) return { error: "No account given." };

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("accounts")
    .update({ owner_id: user.id })
    .eq("id", accountId)
    .is("owner_id", null)
    .select("id")
    .maybeSingle();

  if (error) {
    log.error({ accountId, by: user.id, error: error.message }, "claim failed");
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

  log.info({ accountId, by: user.id }, "account claimed");
  revalidatePath("/available");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
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
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) return { error: "No account given." };

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

  // last_release_reason is set in the same statement so the trigger that closes
  // the claim record can read it. Setting it afterwards would file the release
  // under a guessed reason.
  const { error } = await supabase
    .from("accounts")
    .update({ owner_id: null, last_release_reason: "manual" })
    .eq("id", accountId);

  if (error) {
    log.error({ accountId, by: user.id, error: error.message }, "release failed");
    return { error: friendly(error.message) };
  }

  log.info({ accountId, by: user.id }, "account released");
  revalidatePath("/available");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
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
  if (/does not exist|schema cache/i.test(message)) {
    return (
      "The database is missing something this build expects. An administrator needs to " +
      "re-run setup to apply the latest migrations."
    );
  }
  if (/row-level security|permission denied/i.test(message)) {
    return "You do not have permission to change that account.";
  }
  return message;
}
