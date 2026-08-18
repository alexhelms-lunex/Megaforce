import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Scheduled work, as a list.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * releaseOverdueAccounts() was written, unit tested, and never scheduled.
 * Accounts reached 'overdue' and stayed there forever. Nothing on any screen
 * looked wrong -- the flags were correct, the countdown was correct, the rule
 * simply was never enforced. That is the worst class of bug this system can
 * have, and it survived because "run this every night" existed nowhere as a
 * fact you could look at.
 *
 * So: every recurring task is a row in the array below. Adding one is a
 * function and an entry. The runner records each attempt in job_runs whether it
 * succeeds or not, the Admin screen shows the last run of each, and
 * clock_health() complains if the release job has visibly stopped. A job that
 * quietly stops running now has three places it becomes visible.
 * ---------------------------------------------------------------------------
 */

export interface JobContext {
  /** 'schedule' when the cron fired it, 'manual' when an admin pressed a button. */
  trigger: "schedule" | "manual";
  /** The hour, in UTC, the run started. Jobs that only fire once a day read it. */
  utcHour: number;
}

export interface JobResult {
  /** Counts worth reading on the Admin screen. Keep them short and factual. */
  [key: string]: number | string | boolean;
}

export interface JobDef {
  name: string;
  description: string;
  /**
   * Whether this run should do anything. Called before the job, so a job that
   * is switched off or out of its window is recorded as skipped rather than
   * looking like it ran and found nothing.
   */
  shouldRun?: (ctx: JobContext) => Promise<boolean>;
  run: (ctx: JobContext) => Promise<JobResult>;
}

const log = logger.child({ component: "jobs" });

// ---------------------------------------------------------------------------
// Settings access
// ---------------------------------------------------------------------------

/** Read a setting, falling back when the row is absent or unreadable. */
export async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    const rows = await db.execute<{ value: unknown }>(
      sql`select value from app_settings where key = ${key}`,
    );
    const list = asRows<{ value: unknown }>(rows);
    if (list.length === 0) return fallback;
    return list[0].value as T;
  } catch (err) {
    log.warn({ err, key }, "could not read setting, using fallback");
    return fallback;
  }
}

/**
 * Drizzle's execute returns an array on some drivers and { rows } on others.
 * Normalised once here rather than at twenty call sites.
 */
export function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | null;
  return maybe?.rows ?? [];
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

/**
 * Take back every account that has passed its window.
 *
 * The one that was missing. Idempotent by construction -- it releases what is
 * currently overdue -- so running it twice in an hour, or by hand on top of the
 * schedule, is harmless.
 */
export const releaseOverdue: JobDef = {
  name: "release-overdue-accounts",
  description:
    "Returns accounts past their window to the available pool, and closes their claim records.",
  shouldRun: () => setting<boolean>("lifecycle.release_enabled", true),
  async run() {
    const rows = await db.execute<{ released: number }>(
      sql`select release_overdue_accounts() as released`,
    );
    const released = Number(asRows<{ released: number }>(rows)[0]?.released ?? 0);
    return { released };
  },
};

/**
 * The 5am broker email.
 *
 * The hour and the timezone are settings, so changing when it goes out is a
 * field on a screen rather than a redeploy. The cron runs hourly and this
 * decides whether it is the right hour -- which is the only arrangement where
 * the send time is genuinely editable in the application.
 */
export const dailyDigest: JobDef = {
  name: "daily-digest",
  description: "The morning email: accounts needing attention, calls to write up, book against limit.",
  async shouldRun(ctx) {
    if (!(await setting<boolean>("email.enabled", false))) return false;
    const hour = Number(await setting<number>("email.daily_digest_hour", 5));
    const zone = await setting<string>("email.timezone", "America/New_York");
    return localHour(ctx.utcHour, zone) === hour;
  },
  async run(ctx) {
    const { sendDailyDigest } = await import("@/lib/email/digest");
    return sendDailyDigest(ctx);
  },
};

/**
 * Read connected mailboxes and turn mail into activity.
 *
 * Runs every time the cron fires rather than once a day: an email that counts
 * toward an account's clock should count within the hour, not tomorrow.
 */
export const syncInbox: JobDef = {
  name: "sync-inbox",
  description: "Reads Microsoft 365 mailboxes and logs messages to and from contacts on file.",
  shouldRun: () => setting<boolean>("inbox.enabled", false),
  async run() {
    const { syncMailboxes } = await import("@/lib/email/inbox");
    return syncMailboxes();
  },
};

/**
 * Finish any call that was written down but never filed.
 *
 * The safety net under queue.ts: a hard crash between the webhook's response
 * and the write leaves a payload on disk that nothing would ever look at again.
 * The reasoning, the five-minute floor and the batch limit are all in
 * lib/sweep.ts, which is where the work happens and where it can be tested
 * against a real database.
 */
export const sweepPendingEvents: JobDef = {
  name: "sweep-pending-events",
  description:
    "Finishes any call or email that was received and stored but never turned into activity.",
  async run() {
    const { sweepRawEvents } = await import("@/lib/sweep");
    // Spread rather than returned directly: JobResult is an index signature and
    // a named interface does not satisfy one, even when every field matches.
    const { processed, failed, remaining } = await sweepRawEvents(db);

    /*
     * Clear out live calls at the same time.
     *
     * Same job because it is the same failure: something arrived and nothing
     * finished it. A call whose Disconnected event never came shows as in
     * progress forever, and the person staring at a phantom call on their
     * screen has no way to dismiss it.
     */
    const { pruneLiveCalls } = await import("@/lib/ringcentral/live");
    const staleCalls = await pruneLiveCalls(db);

    return { processed, failed, remaining, staleCalls };
  },
};

/**
 * Keep the RingCentral webhook subscription alive.
 *
 * ---------------------------------------------------------------------------
 * Subscriptions expire -- seven days is the maximum RingCentral allows. When
 * one lapses, calls simply stop arriving. There is no error, no failed request
 * and nothing in any log, because from our side nothing happened at all. The
 * first symptom is a rep asking why nothing has logged since Tuesday.
 *
 * This lived in an Inngest cron, which meant renewal only happened if a service
 * we no longer use was signed up for and healthy -- a silent outage waiting on
 * a dependency nobody would think to check. It belongs beside the other
 * scheduled work, where the Admin screen shows when it last ran.
 *
 * A daily cron against a seven-day expiry gives six missed runs of headroom
 * before anything breaks.
 * ---------------------------------------------------------------------------
 */
export const renewCallSubscription: JobDef = {
  name: "renew-call-subscription",
  description: "Renews the RingCentral webhook subscription, which expires every seven days.",
  async shouldRun() {
    const { env } = await import("@/lib/env");
    return env.ringCentralConfigured;
  },
  async run() {
    const { ensureSubscription } = await import("@/lib/ringcentral/client");
    const { id, action, filters } = await ensureSubscription();
    // Joined rather than nested: a JobResult holds flat values, and which
    // filters were accepted is the answer to "why can I only see my own calls".
    return { subscriptionId: id, action, filters: filters.join(", ") };
  },
};

/**
 * Fetch the calls RingCentral already has, instead of only being told about new ones.
 *
 * ---------------------------------------------------------------------------
 * Alex: "This needs to load like calls even when the app wasnt open."
 *
 * A webhook only delivers while a live subscription points at this deployment.
 * Before one exists, while one is lapsed, or after a delivery is abandoned,
 * nothing arrives -- and nothing complains, because from our side nothing
 * happened. The calls sit in RingCentral's log the whole time.
 *
 * So this is the floor under the webhook, not a replacement for it: the webhook
 * makes a call appear in seconds, this makes sure it appears at all. The
 * reasoning, and why running it repeatedly writes nothing, is in lib/ringcentral/pull.ts.
 *
 * Forty-eight hours, against a cron that fires once a day. The overlap is
 * deliberate and it costs nothing -- every call deduplicates on its telephony
 * session id -- whereas a window narrower than the gap between two runs drops
 * whatever fell between them, silently, which is the exact failure this exists
 * to end. A missed cron run is then survivable rather than a lost day.
 *
 * The dock runs this too, throttled to once a minute across everybody, which is
 * what makes a call appear shortly after somebody looks for it rather than
 * tomorrow morning.
 * ---------------------------------------------------------------------------
 */
export const pullRecentCalls: JobDef = {
  name: "pull-recent-calls",
  description: "Loads recent calls straight from RingCentral, including any the webhook missed.",
  async shouldRun() {
    const { env } = await import("@/lib/env");
    return env.ringCentralConfigured;
  },
  async run() {
    const { importRecentCalls } = await import("@/lib/ringcentral/pull");
    const { fetched, imported, duplicates, matched, unmatched, failed } = await importRecentCalls(
      db,
      { sinceHours: 48 },
    );
    return { fetched, imported, duplicates, matched, unmatched, failed };
  },
};

export const JOBS: JobDef[] = [
  releaseOverdue,
  // Before the digest: the morning email counts calls, and counting them before
  // the overnight backlog has been filed sends everybody the wrong number.
  sweepPendingEvents,
  renewCallSubscription,
  // After the subscription is renewed, so a run that repairs a lapsed webhook
  // also picks up whatever was missed while it was lapsed, in the same pass.
  pullRecentCalls,
  dailyDigest,
  syncInbox,
];

export function findJob(name: string): JobDef | undefined {
  return JOBS.find((j) => j.name === name);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface RunSummary {
  job: string;
  ok: boolean;
  skipped?: boolean;
  result?: JobResult;
  error?: string;
  ms: number;
}

/**
 * Run one job and record the attempt.
 *
 * The job_runs row is written BEFORE the work starts and closed afterwards, so
 * a job that crashes the process still leaves evidence it began. A record
 * written only on success cannot distinguish "never ran" from "died halfway",
 * and those need different fixes.
 */
export async function runJob(job: JobDef, ctx: JobContext): Promise<RunSummary> {
  const started = Date.now();

  if (job.shouldRun && !(await job.shouldRun(ctx))) {
    return { job: job.name, ok: true, skipped: true, ms: Date.now() - started };
  }

  const idRows = await db.execute<{ id: string }>(
    sql`insert into job_runs (job, trigger) values (${job.name}, ${ctx.trigger}) returning id`,
  );
  const runId = asRows<{ id: string }>(idRows)[0]?.id;

  try {
    const result = await job.run(ctx);
    await db.execute(sql`
      update job_runs
         set finished_at = now(), ok = true, result = ${JSON.stringify(result)}::jsonb
       where id = ${runId}
    `);
    log.info({ job: job.name, result }, "job finished");
    return { job: job.name, ok: true, result, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      update job_runs set finished_at = now(), ok = false, error = ${message} where id = ${runId}
    `);
    log.error({ job: job.name, err }, "job failed");
    return { job: job.name, ok: false, error: message, ms: Date.now() - started };
  }
}

/**
 * Run every job whose turn it is.
 *
 * One failing job must not stop the others: the release sweep and the morning
 * email have nothing to do with each other, and a broken mail credential should
 * not also mean nobody's accounts get released.
 */
export async function runDueJobs(ctx: JobContext): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  for (const job of JOBS) {
    out.push(await runJob(job, ctx));
  }
  return out;
}

/**
 * What hour it is in a named timezone, given the hour in UTC.
 *
 * Uses Intl rather than arithmetic on a stored offset, so daylight saving is
 * handled by the platform's own tz database. A hardcoded -5 would send the
 * morning email an hour late for eight months of the year.
 */
export function localHour(utcHour: number, timeZone: string): number {
  const probe = new Date();
  probe.setUTCHours(utcHour, 0, 0, 0);
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).format(probe);
    const parsed = Number.parseInt(formatted, 10);
    // Intl renders midnight as "24" in some locales; normalise it.
    return Number.isFinite(parsed) ? parsed % 24 : utcHour;
  } catch {
    // An unknown timezone must not stop the email entirely.
    log.warn({ timeZone }, "unknown timezone, falling back to UTC");
    return utcHour;
  }
}
