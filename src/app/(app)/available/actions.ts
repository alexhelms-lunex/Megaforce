"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { claimAccount, releaseAccount } from "@/lib/lifecycle";
import { logger } from "@/lib/logger";
import { currentUser } from "@/lib/supabase/server";

const log = logger.child({ component: "claims" });

/**
 * Take an unowned account.
 *
 * Runs against the service-role connection, with authorisation checked
 * explicitly at the top. The claim itself is still race-safe: claimAccount()
 * only matches a row whose owner is null, so two brokers pressing the button in
 * the same second produce one winner and one honest refusal, regardless of
 * which connection each arrived on.
 */
export async function claim(formData: FormData) {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) return { error: "No account given." };

  const result = await claimAccount(db, accountId, user.id);

  if (!result.ok) {
    log.info({ accountId, by: user.id, reason: result.reason }, "claim refused");
    return { error: result.detail };
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
 * Only the current owner, an admin, or credit may. A broker releasing somebody
 * else's account is the same territory theft the claim rules exist to prevent,
 * just pointed the other way.
 */
export async function release(formData: FormData) {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) return { error: "No account given." };

  const [account] = await db
    .select({ ownerId: schema.accounts.ownerId })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1);

  if (!account) return { error: "That account no longer exists." };

  const privileged = user.role === "admin" || user.role === "credit";
  if (account.ownerId !== user.id && !privileged) {
    return { error: "You can only release an account you hold." };
  }

  await releaseAccount(db, accountId, "manual");
  log.info({ accountId, by: user.id }, "account released");

  revalidatePath("/available");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}
