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

export interface ExtensionRow {
  extensionNumber: string;
  name: string;
  email: string | null;
  type: string;
  /** The CRM user this extension is already recorded against, if any. */
  matchedUser: string | null;
  /** A CRM user with the same email who has no extension recorded yet. */
  suggestedUser: { id: string; name: string } | null;
}

export interface ExtensionsResult {
  ok?: boolean;
  error?: string;
  numbers?: { phoneNumber: string; usageType: string | null; extensionNumber: string | null }[];
  extensions?: ExtensionRow[];
}

/**
 * Who can make calls, and which of them the CRM would recognise.
 *
 * ---------------------------------------------------------------------------
 * Two questions, one answer. "What number do I call to test this" is the first
 * thing anybody setting this up asks, and hunting for it through RingCentral's
 * admin site is where an afternoon goes.
 *
 * The second is the one that matters later. A call is credited to whoever made
 * it by matching its extension number against users.rc_extension_id. Until that
 * mapping exists, every call lands on the account OWNER instead -- which looks
 * like working software while quietly corrupting every leaderboard and every
 * commission argument. Forty extensions typed by hand from another browser tab
 * is a job nobody does without a typo.
 *
 * So the numbers come from RingCentral, and the matching is done here: already
 * recorded, or a CRM user with the same email address who has no extension yet.
 * Suggested, never applied automatically -- putting the wrong extension on
 * somebody credits their colleague's calls to them, and an email address is a
 * good guess rather than a fact.
 *
 * On demand rather than on page load. This is two round trips to RingCentral,
 * and the screen it sits on is one somebody opens when they already suspect
 * something is wrong.
 * ---------------------------------------------------------------------------
 */
export async function loadExtensions(): Promise<ExtensionsResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { env } = await import("@/lib/env");
    if (!env.ringCentralConfigured) {
      return { error: "Add the RingCentral credentials first." };
    }

    const { listExtensions, listPhoneNumbers } = await import("@/lib/ringcentral/client");
    const { createClient } = await import("@/lib/supabase/server");

    const [extensions, numbers, supabase] = await Promise.all([
      listExtensions(),
      // A failure here must not lose the extensions, which are the half that
      // matters. An account with no direct numbers is perfectly normal.
      listPhoneNumbers().catch(() => []),
      createClient(),
    ]);

    const { data } = await supabase
      .from("users")
      .select("id, full_name, email, rc_extension_id")
      .eq("active", true);

    const users = (data ?? []) as {
      id: string;
      full_name: string;
      email: string | null;
      rc_extension_id: string | null;
    }[];

    const byExtension = new Map(
      users.filter((u) => u.rc_extension_id).map((u) => [u.rc_extension_id as string, u]),
    );
    const byEmail = new Map(
      users.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u]),
    );

    const rows: ExtensionRow[] = extensions
      // Departments, announcements and voicemail-only extensions cannot make a
      // prospecting call, so listing them is noise in a list read for names.
      .filter((e) => e.type === "User" && e.extensionNumber)
      .map((e) => {
        const matched = byExtension.get(e.extensionNumber);
        const byMail = e.email ? byEmail.get(e.email.toLowerCase()) : undefined;
        return {
          extensionNumber: e.extensionNumber,
          name: e.name,
          email: e.email,
          type: e.type,
          matchedUser: matched?.full_name ?? null,
          suggestedUser:
            !matched && byMail && !byMail.rc_extension_id
              ? { id: byMail.id, name: byMail.full_name }
              : null,
        };
      })
      .sort((a, b) => a.extensionNumber.localeCompare(b.extensionNumber, undefined, { numeric: true }));

    return { ok: true, extensions: rows, numbers };
  } catch (err) {
    return { error: explain(err) };
  }
}

/**
 * Go and get the recent calls, now.
 *
 * ---------------------------------------------------------------------------
 * Alex: "This needs to load like calls even when the app wasnt open. Just the
 * most recent calls in ring central."
 *
 * The subscription only delivers calls made while it is alive and pointing
 * here. This asks RingCentral for what it already has, which is the only way to
 * see a call made before the subscription existed -- and on day one, that is
 * every call there is.
 *
 * Run through the job runner rather than calling the import directly, so the
 * attempt lands in job_runs like every other piece of scheduled work: the Admin
 * screen shows when it last happened, and the dock's automatic pull reads the
 * same row to decide whether it is due.
 * ---------------------------------------------------------------------------
 */
export async function pullCallsNow(): Promise<ActionResult> {
  const refused = await requireAdmin();
  if (refused) return refused;

  try {
    const { env } = await import("@/lib/env");
    if (!env.ringCentralConfigured) {
      return { error: "Add the RingCentral credentials first — there is nowhere to fetch from." };
    }

    const { findJob, runJob } = await import("@/lib/jobs/registry");
    const job = findJob("pull-recent-calls");
    if (!job) return { error: "The call-log job is not registered in this build." };

    const summary = await runJob(job, { trigger: "manual", utcHour: new Date().getUTCHours() });
    if (!summary.ok) return { error: summary.error ?? "The call log could not be read." };

    const { describePull } = await import("@/lib/ringcentral/pull");
    const counts = (summary.result ?? {}) as Record<string, number>;

    revalidatePath("/admin/integrations");
    revalidatePath("/activity");
    revalidatePath("/review");

    return {
      ok: true,
      message: describePull({
        fetched: Number(counts.fetched ?? 0),
        imported: Number(counts.imported ?? 0),
        duplicates: Number(counts.duplicates ?? 0),
        matched: Number(counts.matched ?? 0),
        unmatched: Number(counts.unmatched ?? 0),
        failed: Number(counts.failed ?? 0),
      }),
      href: Number(counts.imported ?? 0) > 0 ? "/activity" : undefined,
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
