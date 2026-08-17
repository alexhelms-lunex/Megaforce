"use server";

import { revalidatePath } from "next/cache";
import { DB_UNCONFIGURED, tryGetDb } from "@/lib/db";
import { resolveUnmatched } from "@/lib/matcher";
import { currentUser } from "@/lib/supabase/server";

/**
 * Attach a queued event to an account.
 *
 * This runs against the service-role connection rather than the user's Supabase
 * client, and that is deliberate. Creating a call activity is a privileged
 * write: the activities insert policy only admits rows with source='manual', so
 * that a rep can add a note but cannot forge a two hour phone call that never
 * happened. Resolution has to write a row with the provider's own source.
 *
 * Because RLS is bypassed here, authorisation is enforced explicitly at the top
 * of the function. That check is the only thing standing between this action
 * and full write access, so it comes first and it fails closed.
 */
export async function resolveQueueItem(formData: FormData) {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };
  if (user.role !== "manager" && user.role !== "admin") {
    return { error: "Only a manager or an admin can resolve queued calls." };
  }

  const unmatchedId = String(formData.get("unmatchedId") ?? "");
  const accountId = String(formData.get("accountId") ?? "");
  if (!unmatchedId || !accountId) return { error: "Pick an account first." };

  const db = tryGetDb();
  if (!db) return { error: DB_UNCONFIGURED };

  let result: Awaited<ReturnType<typeof resolveUnmatched>>;
  try {
    result = await resolveUnmatched(db, unmatchedId, accountId, user.id);
  } catch (err) {
    // A rejected action destroys the page rather than showing a message.
    console.error("resolve threw", err);
    return { error: `Could not attach that call: ${(err as Error).message}` };
  }

  if ("error" in result) {
    console.warn("resolve failed", { unmatchedId, accountId, error: result.error });
    return { error: result.error };
  }

  console.log("queued call resolved", {
    unmatchedId,
    accountId,
    activityId: result.activityId,
    by: user.id,
  });

  revalidatePath("/review");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}
