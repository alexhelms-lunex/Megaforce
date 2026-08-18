"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DB_UNCONFIGURED, schema, tryGetDb, withDeadline } from "@/lib/db";
import { qualify, toRule } from "@/lib/qualify";
import { toE164 } from "@/lib/phone";
import { currentUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { STAGES, type Stage } from "./stages";

/**
 * A server action logs with console, not with pino.
 *
 * A logging framework in a serverless action is a dependency initialised on
 * every cold start to write one line that Vercel captures from stdout either
 * way. It earns nothing here, and an action that throws for ANY reason reports
 * itself to the user as "the specific message is omitted in production builds"
 * -- so the cheapest thing to do with a dependency that buys nothing is to
 * remove it rather than rule it out.
 *
 * The worker and the webhook keep pino. They run outside a request, their
 * output is searched by field, and nobody is staring at a button waiting for
 * them.
 */
const log = {
  info: (data: unknown, message: string) => console.log(message, data),
  error: (data: unknown, message: string) => console.error(message, data),
};

/*
 * Imported, never re-exported.
 *
 * A "use server" file may export async functions and NOTHING else -- every
 * export becomes a callable server reference, and a plain array has no meaning
 * as one. This file used to declare STAGES itself, and Next refused the whole
 * module at runtime with "A use server file can only export async functions,
 * found object". The build succeeded and every screen rendered; only buttons
 * broke, everywhere, because the dock that needs this list is on every page.
 *
 * Re-exporting it from here would fail in exactly the same way. Components
 * import it from ./stages directly.
 */

export interface DockCall {
  id: string;
  /**
   * 'matched' -- the number was on a contact record, so it is already an
   *   activity against a company and only needs writing up.
   * 'unmatched' -- the phone system reported it and nobody on file has that
   *   number. It is a real call that belongs to nobody yet.
   */
  kind: "matched" | "unmatched";
  accountId: string | null;
  accountName: string | null;
  contactName: string | null;
  phone: string | null;
  direction: string | null;
  durationSeconds: number | null;
  result: string | null;
  occurredAt: string;
  loggedAt: string | null;
  stageOutcome: string | null;
  qualifies: boolean;
  qualificationReason: string;
  /** Unmatched only: why it did not land, in words. */
  reason?: string;
}

/**
 * Every call the phone system reported for this person -- matched or not.
 *
 * ---------------------------------------------------------------------------
 * Alex: "I want it to see all calls connected to the ring central account
 * live, within our ring central tab. Even calls to number not in the CRM."
 *
 * A call whose number is on a contact record becomes an activity and shows up
 * here. A call to a number nobody has on file used to go to a manager-only
 * review queue and vanish from the broker's view completely -- which is exactly
 * backwards, because the person who just made the call is the one person who
 * knows who it was with.
 *
 * Both now come back in one list. Unlogged first regardless of time, because an
 * unlogged call is the only thing here that needs doing; a call that has been
 * written up is history.
 * ---------------------------------------------------------------------------
 */
export async function recentCalls(limit = 40): Promise<DockCall[]> {
  // The dock renders on every screen. An empty list is a dock with nothing in
  // it; a throw is the screen behind it replaced by an error page.
  const db = tryGetDb();
  if (!db) return [];
  const user = await currentUser();
  if (!user) return [];

  try {
    // Deadline, not just a catch. The direct Postgres connection can accept a
    // query and never answer it, and this runs on every screen -- an await that
    // never settles is a dock stuck on "Loading…" with nothing to click.
    return await withDeadline(readRecentCalls(db, user.id, limit), { label: "Your calls" });
  } catch (err) {
    /*
     * The comment above was a statement of intent with nothing enforcing it.
     *
     * This reads unmatched_activities.user_id, a column a migration added. If
     * the database is behind the deployment -- a real state, because migrations
     * are applied by visiting a page rather than by deploying -- the query
     * throws, and it throws on every screen, because the dock is on every
     * screen. Returning nothing is a quiet dock; throwing is a broken site.
     */
    log.error({ err }, "could not read recent calls");
    return [];
  }
}

async function readRecentCalls(
  db: NonNullable<ReturnType<typeof tryGetDb>>,
  userId: string,
  limit: number,
): Promise<DockCall[]> {
  const rows = await db
    .select({
      id: schema.activities.id,
      accountId: schema.activities.accountId,
      accountName: schema.accounts.name,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
      phone: schema.contacts.phoneE164,
      direction: schema.activities.direction,
      durationSeconds: schema.activities.durationSeconds,
      result: schema.activities.result,
      occurredAt: schema.activities.occurredAt,
      loggedAt: schema.activities.loggedAt,
      stageOutcome: schema.activities.stageOutcome,
      qualifies: schema.activities.qualifies,
      qualificationReason: schema.activities.qualificationReason,
    })
    .from(schema.activities)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.activities.accountId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.activities.contactId))
    .where(and(eq(schema.activities.type, "call"), eq(schema.activities.userId, userId)))
    .orderBy(sql`(${schema.activities.loggedAt} is not null)`, desc(schema.activities.occurredAt))
    .limit(limit);

  const matched: DockCall[] = rows.map((r) => ({
    id: r.id,
    kind: "matched",
    accountId: r.accountId,
    accountName: r.accountName,
    contactName: r.contactFirst ? `${r.contactFirst} ${r.contactLast}`.trim() : null,
    phone: r.phone,
    direction: r.direction,
    durationSeconds: r.durationSeconds,
    result: r.result,
    occurredAt: r.occurredAt.toISOString(),
    loggedAt: r.loggedAt?.toISOString() ?? null,
    stageOutcome: r.stageOutcome,
    qualifies: r.qualifies,
    qualificationReason: r.qualificationReason,
  }));

  /*
   * The calls that matched nothing.
   *
   * Scoped by user_id, which 0033 added -- before that these rows did not know
   * whose call they were and could only ever be shown to a manager.
   *
   * Own calls only, managers included. Asked and answered: "Every person only
   * ever sees calls from their own extension. Managers included -- they would
   * use Reports for oversight instead of the dock."
   *
   * So a call from an extension nobody has claimed appears in NO dock. That is
   * a real gap and it is handled by saying so rather than by leaking: the dock
   * reports how many such calls exist and points at the screen where an
   * extension is attached to a person, and attaching it hands every one of
   * those calls back to whoever made them.
   */
  const orphans = await db
    .select({
      id: schema.unmatchedActivities.id,
      reason: schema.unmatchedActivities.reason,
      phone: schema.unmatchedActivities.phoneE164,
      direction: schema.unmatchedActivities.direction,
      durationSeconds: schema.unmatchedActivities.durationSeconds,
      result: schema.unmatchedActivities.result,
      occurredAt: schema.unmatchedActivities.occurredAt,
      createdAt: schema.unmatchedActivities.createdAt,
    })
    .from(schema.unmatchedActivities)
    .where(
      and(
        eq(schema.unmatchedActivities.userId, userId),
        isNull(schema.unmatchedActivities.resolvedAt),
      ),
    )
    .orderBy(desc(schema.unmatchedActivities.occurredAt))
    .limit(limit);

  const unmatched: DockCall[] = orphans.map((r) => ({
    id: r.id,
    kind: "unmatched",
    accountId: null,
    accountName: null,
    contactName: null,
    phone: r.phone,
    direction: r.direction,
    durationSeconds: r.durationSeconds,
    result: r.result,
    // occurred_at is nullable on this table; the row was still created when the
    // call arrived, so that is the honest fallback rather than the epoch.
    occurredAt: (r.occurredAt ?? r.createdAt).toISOString(),
    loggedAt: null,
    stageOutcome: null,
    qualifies: false,
    qualificationReason: EXPLAIN_UNMATCHED[r.reason] ?? r.reason,
    reason: r.reason,
  }));

  /*
   * Merged and re-sorted, rather than appended.
   *
   * Two lists stacked would put every unmatched call below every matched one
   * regardless of when they happened, and the call somebody just made is the
   * one they are looking for. Outstanding work first, then newest.
   */
  return [...matched, ...unmatched]
    .sort((a, b) => {
      const aDone = a.kind === "matched" && a.loggedAt !== null;
      const bDone = b.kind === "matched" && b.loggedAt !== null;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return b.occurredAt.localeCompare(a.occurredAt);
    })
    .slice(0, limit);
}

export interface LiveCall {
  id: string;
  accountId: string | null;
  accountName: string | null;
  contactName: string | null;
  phone: string | null;
  direction: string | null;
  /** 'ringing' | 'answered' | 'ended' */
  state: string;
  /** ISO. The second counter runs from here once they have picked up. */
  answeredAt: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * The calls happening right now, on this person's own handset.
 *
 * ---------------------------------------------------------------------------
 * Alex: "If I make a call right now it needs to show there even if the person
 * has not even picked up. with a live second counter."
 *
 * Their own only, and that was asked about rather than assumed: "Every person
 * only ever sees calls from their own extension. Managers included." A dock
 * showing a manager who each of their brokers is talking to at this second is
 * surveillance; Reports are where oversight belongs.
 *
 * Ended calls are included for a few minutes rather than disappearing the
 * instant somebody hangs up. A call that vanishes at the exact moment it
 * finishes is the moment somebody looks down to write it up.
 * ---------------------------------------------------------------------------
 */
export async function liveCalls(): Promise<LiveCall[]> {
  const db = tryGetDb();
  if (!db) return [];
  const user = await currentUser();
  if (!user) return [];

  try {
    return await withDeadline(readLiveCalls(db, user.id), { ms: 5_000, label: "Live calls" });
  } catch (err) {
    /*
     * The dock is on every screen, and this runs every four seconds.
     *
     * If live_calls does not exist yet -- the database is behind the code, which
     * is a state this application can genuinely be in, because migrations are
     * applied by visiting a page rather than by deploying -- then every one of
     * those calls throws. An empty list is a dock with no live call in it, which
     * is true and harmless. A rejection is an unhandled error on every page,
     * every four seconds.
     */
    log.error({ err }, "could not read live calls");
    return [];
  }
}

async function readLiveCalls(
  db: NonNullable<ReturnType<typeof tryGetDb>>,
  userId: string,
): Promise<LiveCall[]> {
  const rows = await db
    .select({
      id: schema.liveCalls.telephonySessionId,
      accountId: schema.liveCalls.accountId,
      accountName: schema.accounts.name,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
      counterpartyName: schema.liveCalls.counterpartyName,
      phone: schema.liveCalls.counterpartyNumber,
      direction: schema.liveCalls.direction,
      state: schema.liveCalls.state,
      startedAt: schema.liveCalls.startedAt,
      answeredAt: schema.liveCalls.answeredAt,
      endedAt: schema.liveCalls.endedAt,
    })
    .from(schema.liveCalls)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.liveCalls.accountId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.liveCalls.contactId))
    .where(
      and(
        eq(schema.liveCalls.userId, userId),
        // Still going, or only just over.
        sql`(${schema.liveCalls.endedAt} is null or ${schema.liveCalls.endedAt} > now() - interval '3 minutes')`,
      ),
    )
    .orderBy(desc(schema.liveCalls.startedAt))
    .limit(5);

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    contactName: r.contactFirst
      ? `${r.contactFirst} ${r.contactLast}`.trim()
      : (r.counterpartyName ?? null),
    phone: r.phone,
    direction: r.direction,
    state: r.state,
    startedAt: r.startedAt.toISOString(),
    answeredAt: r.answeredAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
  }));
}

export interface DockHealth {
  /** The signed-in person's RingCentral extension, when one is recorded. */
  extension: string | null;
  /** Calls sitting unattributed because their extension matches nobody. */
  unclaimed: number;
  /** True when this person may go and fix that. */
  canFix: boolean;
}

/**
 * Why the dock might be empty when the phone has been ringing all morning.
 *
 * ---------------------------------------------------------------------------
 * A call is credited to whoever made it by matching its extension against
 * users.rc_extension_id. Until that mapping exists nothing matches, so a person
 * with no extension recorded sees an empty dock forever -- and everything else
 * on every screen looks perfectly healthy, because the calls DID arrive.
 *
 * Since the dock shows only your own calls, this is the difference between "no
 * calls today" and "every call today went somewhere you cannot see". Those need
 * completely different actions and they look identical, so the dock says which.
 * ---------------------------------------------------------------------------
 */
export async function dockHealth(): Promise<DockHealth> {
  const db = tryGetDb();
  const user = await currentUser();
  if (!db || !user) return { extension: null, unclaimed: 0, canFix: false };

  try {
    return await withDeadline(readDockHealth(db, user.id, user.role), {
      ms: 5_000,
      label: "The dock",
    });
  } catch (err) {
    // Same reasoning as liveCalls: a diagnostic that throws takes down the
    // thing it was meant to explain.
    log.error({ err }, "could not read dock health");
    return { extension: null, unclaimed: 0, canFix: false };
  }
}

async function readDockHealth(
  db: NonNullable<ReturnType<typeof tryGetDb>>,
  userId: string,
  role: string,
): Promise<DockHealth> {
  const [me] = await db
    .select({ extension: schema.users.rcExtensionId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (me?.extension) return { extension: me.extension, unclaimed: 0, canFix: false };

  // Only worth counting when they have no extension: that is the only state in
  // which this number explains anything.
  const orphaned = await db
    .select({ id: schema.unmatchedActivities.id })
    .from(schema.unmatchedActivities)
    .where(
      and(
        isNull(schema.unmatchedActivities.userId),
        isNull(schema.unmatchedActivities.resolvedAt),
      ),
    )
    .limit(200);

  return {
    extension: null,
    unclaimed: orphaned.length,
    canFix: role === "admin",
  };
}

/**
 * Ask RingCentral for anything that happened while nobody was looking.
 *
 * ---------------------------------------------------------------------------
 * Alex: "This needs to load like calls even when the app wasnt open."
 *
 * Opening the dock is the exact moment somebody expects to see the call they
 * just made, and it is also the moment the CRM finds out anybody is watching.
 * A subscription that lapsed on Thursday, a deployment whose URL changed, a
 * call made before any of this was connected -- all of them look identical from
 * inside the dock, which is to say they look like an empty list.
 *
 * So the dock asks. It does not wait for the answer to render: the list draws
 * from the database immediately, and reloads if the pull brought anything new.
 * A dock that spends two seconds on a network round trip before showing calls
 * it already had is worse than one that never pulled at all.
 *
 * THE THROTTLE IS SERVER SIDE, ON PURPOSE
 *
 * Every broker with the dock open would otherwise hit RingCentral on every
 * open, on every machine. The gate reads job_runs -- the same row the Admin
 * screen shows and the cron writes -- so it holds across all of them, and a
 * pull that just happened for one person counts for everybody.
 *
 * Nothing here is destructive and nothing is refused loudly: a throttled call
 * returns imported: 0 and the dock simply carries on with what it has.
 * ---------------------------------------------------------------------------
 */
export async function syncRecentCalls(): Promise<{ imported: number; error?: string }> {
  try {
    const user = await currentUser();
    if (!user) return { imported: 0 };
    if (!env.ringCentralConfigured) return { imported: 0 };

    const db = tryGetDb();
    if (!db) return { imported: 0 };

    const { secondsSinceLastPull } = await import("@/lib/ringcentral/pull");
    const age = await secondsSinceLastPull(db);
    // Sixty seconds. Short enough that a call made a minute ago turns up on the
    // next open, long enough that a floor of brokers is one request a minute.
    if (age !== null && age < 60) return { imported: 0 };

    const { findJob, runJob } = await import("@/lib/jobs/registry");
    const job = findJob("pull-recent-calls");
    if (!job) return { imported: 0 };

    const summary = await runJob(job, { trigger: "manual", utcHour: new Date().getUTCHours() });
    if (!summary.ok) return { imported: 0, error: summary.error };

    return { imported: Number(summary.result?.imported ?? 0) };
  } catch (err) {
    // The dock renders on every screen. A failed pull is a dock showing what it
    // already had; a throw is the page behind it replaced by an error.
    log.error({ err }, "dock could not pull the call log");
    return { imported: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make sure RingCentral is delivering calls here, without anybody asking.
 *
 * ---------------------------------------------------------------------------
 * Alex: "I SHOULD NOT HAVE TO RENEW OR ANYTHING. The app opens. The API is
 * connected and were gtg."
 *
 * He is right, and a button was the wrong answer. A subscription expires after
 * seven days, and when it lapses calls simply stop -- no error, nothing in any
 * log. Putting the repair behind a button means the repair happens only if
 * somebody already suspects there is something to repair, which is exactly the
 * knowledge a lapsed subscription denies you.
 *
 * So it is checked when the application opens, throttled to once an hour across
 * everybody by the same job_runs row the Admin screen reads. Two RingCentral
 * calls an hour for a company, against a seven-day expiry, is nothing -- and it
 * means the phone is connected because the CRM keeps it connected.
 *
 * Silent on the way through. If it cannot be fixed the Phone connection screen
 * says so in words; a toast on every page load would be noise nobody can act on.
 * ---------------------------------------------------------------------------
 */
export async function ensureDelivery(): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await currentUser();
    if (!user) return { ok: false };
    if (!env.ringCentralConfigured) return { ok: false };

    const db = tryGetDb();
    if (!db) return { ok: false };

    const { asRows } = await import("@/lib/jobs/registry");
    const age = asRows<{ age: string | null }>(
      await withDeadline(
        db.execute(sql`
          select extract(epoch from (now() - max(started_at)))::text as age
            from job_runs
           where job = 'renew-call-subscription'
        `),
        { ms: 5_000, label: "The database" },
      ),
    )[0]?.age;

    // Once an hour is plenty against a seven-day expiry, and it means a lapse
    // is repaired within the hour rather than whenever somebody notices.
    if (age !== null && age !== undefined && Number(age) < 3_600) return { ok: true };

    const { findJob, runJob } = await import("@/lib/jobs/registry");
    const job = findJob("renew-call-subscription");
    if (!job) return { ok: false };

    const summary = await runJob(job, { trigger: "manual", utcHour: new Date().getUTCHours() });
    return summary.ok ? { ok: true } : { ok: false, error: summary.error };
  } catch (err) {
    // The dock is on every screen. This never surfaces to the person; the
    // Phone connection screen is where a broken connection is explained.
    log.error({ err }, "could not ensure call delivery");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Why a call did not land on a company, written for the person who made it. */
const EXPLAIN_UNMATCHED: Record<string, string> = {
  no_contact_match: "Nobody on file has this number. Say who it was with and it will count.",
  multiple_accounts: "This number is on more than one company. Pick which one.",
  unusable_phone_number: "The number came through unreadable — withheld, or malformed.",
  unusable_email_address: "The address came through unreadable.",
};

/**
 * Say which company an unmatched call was with.
 *
 * ---------------------------------------------------------------------------
 * WHY A BROKER MAY DO THIS AND WHY IT IS STILL SAFE
 *
 * Attaching a call creates an activity carrying the PROVIDER's source rather
 * than 'manual', which the ordinary insert policy refuses -- that policy is
 * what stops somebody forging a two hour phone call. So this runs on the
 * service connection, with row level security bypassed, and every check has to
 * be made here explicitly.
 *
 * Two of them, and both matter:
 *
 *   The call must be THEIRS. Read from their own Supabase client, so the policy
 *     added in 0033 decides -- their own calls, or anything if they triage.
 *   The account must be one they may OPEN, checked the same way. Without this a
 *     broker could attach their call to a colleague's account, which would put
 *     activity on a book they cannot see and quietly hold somebody else's clock.
 *
 * Neither check trusts the form. Both ask Postgres.
 * ---------------------------------------------------------------------------
 */
export async function attachCall(
  unmatchedId: string,
  accountId: string,
): Promise<{ ok?: true; error?: string }> {
  try {
    if (!unmatchedId || !accountId) return { error: "Pick a company first." };

    const user = await currentUser();
    if (!user) return { error: "Not signed in." };

    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();

    const [{ data: queued }, { data: account }] = await Promise.all([
      supabase
        .from("unmatched_activities")
        .select("id")
        .eq("id", unmatchedId)
        .is("resolved_at", null)
        .maybeSingle(),
      supabase.from("accounts").select("id").eq("id", accountId).maybeSingle(),
    ]);

    if (!queued) {
      return { error: "That call is not yours to attach, or somebody already has." };
    }
    if (!account) {
      return { error: "You cannot open that company, so a call cannot be attached to it." };
    }

    const db = tryGetDb();
    if (!db) return { error: DB_UNCONFIGURED };

    const { resolveUnmatched } = await import("@/lib/matcher");
    const result = await resolveUnmatched(db, unmatchedId, accountId, user.id);
    if ("error" in result) return { error: result.error };

    for (const path of ["/", "/activity", "/review", `/accounts/${accountId}`]) {
      try {
        revalidatePath(path);
      } catch {
        /* a stale cache entry is one refresh from being right */
      }
    }
    return { ok: true };
  } catch (err) {
    return { error: `Could not attach that call: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Companies to attach an unmatched call to.
 *
 * Runs on the caller's own Supabase client, so row level security decides what
 * comes back -- a broker is offered their own book and the available pool, and
 * never a colleague's account. That is not a courtesy: attaching a call to
 * somebody else's account would put activity on a book the person cannot see
 * and quietly hold another broker's clock open.
 *
 * Searched through prospect_list rather than a LIKE over names, so it behaves
 * exactly like the search box on Prospects -- punctuation flattened, every word
 * required, city and industry included. Two search boxes that disagree about
 * what "smith and sons" means is how somebody concludes a company is missing.
 */
export async function searchCompanies(
  query: string,
): Promise<{ id: string; name: string; detail: string }[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data } = await supabase.rpc("prospect_list", {
      p_search: term,
      // Only what the caller may open. A held company cannot receive their call.
      p_scope: "all",
      p_state: "",
      p_industry: "",
      p_status: "",
      p_sort: "relevance",
      p_limit: 25,
      p_offset: 0,
    });

    return ((data ?? []) as Record<string, unknown>[])
      .filter((r) => r.can_open)
      .slice(0, 12)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        detail:
          [r.billing_city, r.billing_state].filter(Boolean).join(", ") ||
          String(r.industry ?? "no address on file"),
      }));
  } catch {
    // The dock renders on every screen. An empty list is a search with no
    // results; a throw is the page behind it replaced by an error.
    return [];
  }
}

export interface MatchOptions {
  accounts: { id: string; name: string; contactCount: number }[];
  contacts: { id: string; accountId: string; label: string; detail: string }[];
}

/**
 * Which companies and contacts hold this number.
 *
 * Drives the two dropdowns. Every candidate is returned rather than one being
 * guessed at: a number genuinely can sit at two customers, and several contacts
 * genuinely can share one switchboard with different extensions, different
 * emails, or nothing at all to tell them apart. The broker who just made the
 * call knows which; this code does not.
 */
export async function matchOptions(rawPhone: string): Promise<MatchOptions> {
  const db = tryGetDb();
  if (!db) return { accounts: [], contacts: [] };
  const phone = toE164(rawPhone);
  if (!phone) return { accounts: [], contacts: [] };

  const rows = await db
    .select({
      contactId: schema.contacts.id,
      accountId: schema.accounts.id,
      accountName: schema.accounts.name,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      title: schema.contacts.title,
      email: schema.contacts.email,
      type: schema.contacts.type,
    })
    .from(schema.contacts)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.contacts.accountId))
    .where(eq(schema.contacts.phoneE164, phone))
    .orderBy(schema.accounts.name, schema.contacts.lastName);

  const byAccount = new Map<string, { id: string; name: string; contactCount: number }>();
  for (const r of rows) {
    const existing = byAccount.get(r.accountId);
    if (existing) existing.contactCount += 1;
    else byAccount.set(r.accountId, { id: r.accountId, name: r.accountName, contactCount: 1 });
  }

  return {
    accounts: [...byAccount.values()],
    contacts: rows.map((r) => ({
      id: r.contactId,
      accountId: r.accountId,
      label: `${r.firstName} ${r.lastName}`.trim(),
      // Whatever distinguishes otherwise-identical rows. When nothing does, the
      // broker picks the first and that is genuinely fine.
      detail: [r.title, r.type, r.email].filter(Boolean).join(" · ") || "no other details on file",
    })),
  };
}

export interface LogResult {
  ok?: true;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Write up a call.
 *
 * All four fields are required, and they are checked here rather than trusted
 * from the form — a required attribute in markup is a courtesy to the browser,
 * not a rule. The database carries the same constraint underneath, so a
 * half-filled log cannot exist by any route.
 *
 * Saving is what makes the call count: the qualifier refuses a call with no
 * stage outcome, so this is the moment a 90-second conversation turns into an
 * approved activity and resets the account's clock.
 */
export async function logCall(_prev: LogResult, form: FormData): Promise<LogResult> {
  const db = tryGetDb();
  if (!db) return { error: DB_UNCONFIGURED };
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const activityId = String(form.get("activityId") ?? "");
  const accountId = String(form.get("accountId") ?? "");
  const contactId = String(form.get("contactId") ?? "");
  const notes = String(form.get("notes") ?? "").trim();
  const stage = String(form.get("stageOutcome") ?? "");

  const fieldErrors: Record<string, string> = {};
  if (!accountId) fieldErrors.accountId = "Pick the company.";
  if (!contactId) fieldErrors.contactId = "Pick who you spoke to.";
  if (!notes) fieldErrors.notes = "Notes are required.";
  if (!STAGES.includes(stage as Stage)) fieldErrors.stageOutcome = "Pick a stage.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  if (!activityId) return { error: "No call selected." };

  const [call] = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.id, activityId))
    .limit(1);
  if (!call) return { error: "That call no longer exists." };

  const [rule] = await db
    .select()
    .from(schema.qualificationRules)
    .where(
      and(
        eq(schema.qualificationRules.activityType, "call"),
        eq(schema.qualificationRules.active, true),
      ),
    )
    .limit(1);

  // Re-run qualification now that the outcome exists. Until this moment the
  // call sat with "not yet logged" as its reason.
  const verdict = qualify(
    {
      type: "call",
      durationSeconds: call.durationSeconds,
      result: call.result,
      direction: (call.direction ?? null) as "inbound" | "outbound" | null,
      stageOutcome: stage,
    },
    rule ? toRule(rule) : null,
  );

  await db
    .update(schema.activities)
    .set({
      accountId,
      contactId,
      notes,
      stageOutcome: stage,
      loggedBy: user.id,
      loggedAt: new Date(),
      qualifies: verdict.qualifies,
      qualificationReason: verdict.reason,
    })
    .where(eq(schema.activities.id, activityId));

  log.info(
    { activityId, accountId, stage, by: user.id, qualifies: verdict.qualifies },
    "call logged",
  );

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}

/**
 * Place a call.
 *
 * RingCentral's click-to-call rings the broker's own handset first, then dials
 * the customer. Without credentials there is nothing to ring, so this reports
 * that plainly instead of appearing to work.
 */
export async function placeCall(rawPhone: string): Promise<{ ok?: true; error?: string }> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const phone = toE164(rawPhone);
  if (!phone) return { error: "That number cannot be dialled. Check the area code." };

  if (!env.ringCentralConfigured) {
    return {
      error:
        "RingCentral is not connected yet. Add RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT " +
        "to switch the dialler on.",
    };
  }

  /*
   * RingOut, not telephony/call-out.
   *
   * ---------------------------------------------------------------------------
   * This used to POST to /telephony/call-out with `from: { deviceId: user.id }`
   * -- a CRM UUID passed off as a RingCentral device id. There is no such
   * device, so RingCentral answered 400 every time, and the dialler had never
   * placed a single call.
   *
   * RingOut is the right endpoint anyway: it rings the caller's own number
   * first, then dials the customer once they pick up, which is exactly what the
   * screen has always promised. It also needs no device id -- two phone numbers
   * are enough.
   *
   * The `from` number is the caller's own direct line, found from the extension
   * recorded against them. Getting it wrong is not cosmetic: `from` is the
   * handset that rings, so a stale number rings somebody else's desk.
   * ---------------------------------------------------------------------------
   */
  try {
    const db = tryGetDb();
    const [me] = db
      ? await db
          .select({ extension: schema.users.rcExtensionId })
          .from(schema.users)
          .where(eq(schema.users.id, user.id))
          .limit(1)
      : [];

    if (!me?.extension) {
      return {
        error:
          "No RingCentral extension is recorded against you, so there is no handset to ring. " +
          "An administrator can attach one on the Phone connection screen.",
      };
    }

    /*
     * The number that will ring, found from BOTH endpoints.
     *
     * ---------------------------------------------------------------------------
     * This read only listExtensions().directNumber, which was empty, so the
     * dialler refused with "extension 101 has no direct number" -- while the
     * screen directly above it listed +1 (323) 485-5837 as a DirectNumber that
     * rings extension 101. Both were reading RingCentral; only one was asking
     * the endpoint that knows.
     *
     * A number's association with an extension lives on the PHONE NUMBER, not on
     * the extension, so that is where it is looked for first. The extension's
     * own field is kept as a fallback because some accounts populate it, and the
     * main company number is the last resort: a call from the switchboard is
     * still a call, and refusing to dial is worse than dialling from the general
     * number.
     * ---------------------------------------------------------------------------
     */
    const { rcToken, listExtensions, listPhoneNumbers } = await import("@/lib/ringcentral/client");
    const [extensions, numbers] = await Promise.all([
      listExtensions(),
      listPhoneNumbers().catch(() => []),
    ]);

    const mine = extensions.find((e) => e.extensionNumber === me.extension);
    const fromNumber =
      numbers.find((n) => n.extensionNumber === me.extension)?.phoneNumber ??
      mine?.directNumber ??
      numbers.find((n) => n.usageType === "MainCompanyNumber")?.phoneNumber ??
      null;

    if (!fromNumber) {
      return {
        error:
          `No number on the RingCentral account rings extension ${me.extension}, and there is ` +
          "no main company number to dial from either.",
      };
    }

    const token = await rcToken();
    const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/account/~/extension/~/ring-out`, {
      method: "POST",
      // Bounded like every other call to RingCentral. Node's fetch waits
      // forever by default, and a dialler that hangs is worse than one that
      // fails: the broker keeps pressing it.
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { phoneNumber: fromNumber },
        to: { phoneNumber: phone },
        // No "press 1 to connect". The broker asked for the call; making them
        // confirm it on the handset is a step that exists to prevent misdials
        // from an autodialler, which this is not.
        playPrompt: false,
      }),
    });

    if (!res.ok) {
      // The body says which parameter, which is the difference between a
      // fixable problem and a shrug.
      const detail = (await res.text()).slice(0, 300);
      return { error: `RingCentral refused the call (${res.status}). ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    log.error({ err }, "click-to-call failed");
    return {
      error: `Could not reach RingCentral: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Calls the caller has not written up yet. Drives the dock's badge. */
export async function unloggedCount(): Promise<number> {
  const db = tryGetDb();
  if (!db) return 0;
  const user = await currentUser();
  if (!user) return 0;
  const rows = await db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.type, "call"),
        eq(schema.activities.userId, user.id),
        isNull(schema.activities.loggedAt),
      ),
    );
  return rows.length;
}
