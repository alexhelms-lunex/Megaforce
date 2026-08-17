"use server";

import { revalidatePath } from "next/cache";
import { createClient, loadCurrentUser, noUserMessage } from "@/lib/supabase/server";

export interface AssignResult {
  ok?: boolean;
  message?: string;
  error?: string;
}

/**
 * Put a broker on an account an Account Director opened.
 *
 * ---------------------------------------------------------------------------
 * A thin wrapper. Every rule lives in assign_broker_to_account() in 0027,
 * deliberately: this action runs with the caller's own privileges, so it can
 * neither widen nor narrow what the database allows, and hiding the button on a
 * screen is not a permission.
 *
 * The function returns a SENTENCE rather than raising, so a refusal arrives as
 * something to read -- "raise a transfer request instead", "you can only assign
 * somebody who reports to you" -- rather than as a constraint violation.
 * ---------------------------------------------------------------------------
 */
export async function assignBroker(accountId: string, brokerId: string): Promise<AssignResult> {
  try {
    if (!accountId || !brokerId) return { error: "Pick somebody first." };

    const lookup = await loadCurrentUser();
    if (!lookup.user) return { error: noUserMessage(lookup) };

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("assign_broker_to_account", {
      p_account_id: accountId,
      p_broker: brokerId,
    });

    if (error) {
      if (/does not exist|schema cache|could not find/i.test(error.message)) {
        return {
          error:
            "The database is behind this version of the app. An administrator needs to apply " +
            `the latest changes from the setup page. (${error.message})`,
        };
      }
      return { error: error.message };
    }

    const outcome = String(data ?? "");
    if (outcome !== "ok") return { error: outcome || "That did not work." };

    for (const path of ["/accounts", `/accounts/${accountId}`, "/directory", "/"]) {
      try {
        revalidatePath(path);
      } catch {
        /* a stale cache entry is one refresh from being right */
      }
    }

    return { ok: true, message: "Added. The clock starts on them now." };
  } catch (err) {
    return {
      error: `Could not assign them: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
