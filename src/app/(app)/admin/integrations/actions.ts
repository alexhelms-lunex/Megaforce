"use server";

import { revalidatePath } from "next/cache";
import { loadCurrentUser, noUserMessage } from "@/lib/supabase/server";

export interface ActionResult {
  ok?: boolean;
  message?: string;
  error?: string;
  /** Where to go and look at what just happened, when there is somewhere. */
  href?: string;
}

/**
 * Only an administrator, checked here rather than trusted from the screen.
 *
 * Both actions below reach RingCentral with the company's own credentials, and
 * one of them changes where every future call is delivered. Hiding a button is
 * not a permission -- these are server actions, addressable by anybody signed
 * in who knows the id.
 */
async function requireAdmin(): Promise<{ error: string } | null> {
  const lookup = await loadCurrentUser();
  if (!lookup.user) return { error: noUserMessage(lookup) };
  if (lookup.user.role !== "admin") {
    return { error: "Only an administrator can change the phone connection." };
  }
  return null;
}

/**
 * Create or renew the subscription, now.
 *
 * The daily job does this on its own. The button exists because the one moment
 * somebody needs it is during setup -- credentials have just been pasted in,
 * and waiting until tomorrow morning to find out whether they work is not a
 * setup experience anybody finishes.
 */
export async function renewNow(): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { env } = await import("@/lib/env");
    if (!env.ringCentralConfigured) {
      return {
        error:
          "RingCentral is not configured yet. Add the client ID, client secret and JWT to the " +
          "deployment's environment variables first.",
      };
    }

    const { ensureSubscription } = await import("@/lib/ringcentral/client");
    const { id, action } = await ensureSubscription();

    revalidatePath("/admin/integrations");
    return {
      ok: true,
      message:
        action === "created"
          ? `Subscription created. RingCentral will start delivering calls here. (${id})`
          : `Subscription renewed for another seven days. (${id})`,
    };
  } catch (err) {
    return { error: explain(err) };
  }
}

/**
 * Prove the credentials work, without changing anything.
 *
 * Separate from renewing on purpose. "Do my credentials work" and "point the
 * phone system at this deployment" are different questions, and somebody
 * checking the first should not have to perform the second to find out.
 */
export async function testConnection(): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { env } = await import("@/lib/env");
    if (!env.ringCentralConfigured) {
      const missing = ["RC_CLIENT_ID", "RC_CLIENT_SECRET", "RC_JWT"].filter(
        (k) => !process.env[k],
      );
      return { error: `Still missing: ${missing.join(", ")}.` };
    }

    const { rcToken, resetTokenCache } = await import("@/lib/ringcentral/client");
    // Cleared first, so pressing this after fixing a credential actually tests
    // the new one rather than returning the cached token from the old one.
    resetTokenCache();
    await rcToken();

    revalidatePath("/admin/integrations");
    return { ok: true, message: "Signed in to RingCentral successfully." };
  } catch (err) {
    return { error: explain(err) };
  }
}

/**
 * Push a call through the pipeline without a phone system.
 *
 * Touches nothing outside this deployment -- no RingCentral account, no
 * credentials, no network. It builds the payload RingCentral would have sent
 * and feeds it through the identical front door, so everything after that point
 * is the real thing being demonstrated rather than a mock of it.
 *
 * Admin only, like everything else here, because it writes activity rows.
 */
export async function sendTestCall(kind: "connected" | "brief" | "unknown"): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const lookup = await loadCurrentUser();
    const { simulateCall } = await import("@/lib/demo-call");
    const result = await simulateCall(kind, lookup.user?.id ?? null);

    revalidatePath("/admin/integrations");
    revalidatePath("/activity");
    revalidatePath("/review");

    return result.ok
      ? { ok: true, message: result.message, href: result.href }
      : { error: result.message };
  } catch (err) {
    return { error: explain(err) };
  }
}

/** Take the simulated calls back out, so demo data does not become real data. */
export async function clearTestCalls(): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { clearSimulatedCalls } = await import("@/lib/demo-call");
    const removed = await clearSimulatedCalls();

    revalidatePath("/admin/integrations");
    revalidatePath("/activity");
    revalidatePath("/review");

    return {
      ok: true,
      message: removed === 0 ? "There were none to remove." : `Removed ${removed}.`,
    };
  } catch (err) {
    return { error: explain(err) };
  }
}

/** Work through the backlog now rather than waiting for tonight's sweep. */
export async function sweepNow(): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { findJob, runJob } = await import("@/lib/jobs/registry");
    const job = findJob("sweep-pending-events");
    if (!job) return { error: "The sweep job is not registered in this build." };

    const summary = await runJob(job, { trigger: "manual", utcHour: new Date().getUTCHours() });
    if (!summary.ok) return { error: summary.error ?? "The sweep failed." };

    const { processed = 0, failed = 0, remaining = 0 } = summary.result ?? {};
    revalidatePath("/admin/integrations");
    return {
      ok: true,
      message:
        Number(processed) === 0 && Number(remaining) === 0
          ? "Nothing was waiting."
          : `Filed ${processed}. ${failed} could not be read. ${remaining} still waiting.`,
    };
  } catch (err) {
    return { error: explain(err) };
  }
}

/**
 * The whole chain of causes, not just the outermost one.
 *
 * A failed token request wraps a fetch error wraps a DNS failure, and only the
 * innermost says "getaddrinfo ENOTFOUND" -- which is the one that tells
 * somebody they typed the server address wrong.
 */
function explain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (e?.message && !parts.includes(e.message)) parts.push(e.message);
    current = e?.cause;
  }
  return parts.join(" — ") || String(err);
}
