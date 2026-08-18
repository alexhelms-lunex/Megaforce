import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { storeRawEvent, extractExternalId } from "@/lib/ingest";
import { processRawEvent, type Db } from "@/lib/matcher";
import { buildCallLogPayload } from "@/lib/ringcentral/payloads";

/**
 * Go and get the calls, rather than waiting to be told about them.
 *
 * ===========================================================================
 * WHY THIS EXISTS WHEN A WEBHOOK ALREADY DOES THE SAME JOB
 *
 * Alex: "This needs to load like calls even when the app wasnt open. Just the
 * most recent calls in ring central."
 *
 * A webhook only delivers a call that happens while a live subscription is
 * pointing at this deployment. Three situations break that, and every one of
 * them is silent -- no error, no failed request, nothing in any log, because
 * from our side nothing happened at all:
 *
 *   BEFORE the subscription exists. Day one. Also right now.
 *   WHILE it is lapsed, or pointing at a previous deployment's URL. RingCentral
 *     does not resend afterwards.
 *   AFTER a delivery fails enough times to be abandoned.
 *
 * In all three the calls are sitting in RingCentral's own log, complete and
 * untouched, and the CRM simply never asked for them. This asks.
 *
 * A pull is therefore not a fallback for a broken webhook. It is the floor: the
 * webhook makes a call appear within seconds, and this makes sure it appears at
 * all. Keeping both is why "did the subscription lapse last Thursday" stops
 * being a question anybody has to answer.
 *
 * IT IS THE SAME PIPELINE, NOT A SECOND ONE
 *
 * Each record is wrapped in the identical envelope the webhook delivers and
 * pushed through the identical front door -- storeRawEvent, then
 * processRawEvent. The matcher, the extension lookup, the qualifier and the
 * review queue cannot tell a pulled call from a delivered one, which is the
 * point: a second code path would be a second set of bugs, and the one that
 * only runs during an outage is the one nobody ever tests.
 *
 * SAFE TO RUN AS OFTEN AS YOU LIKE
 *
 * The external id is the telephony session id, which is what a Call Log Sync
 * notification carries too. So a call that arrives BOTH ways collides on the
 * unique index over (source, external_id) and is stored once. Re-running this
 * across a window that has already been imported writes nothing at all.
 * ===========================================================================
 */

const log = logger.child({ component: "rc-pull" });

export interface PullSummary {
  /** Records RingCentral returned for the window. */
  fetched: number;
  /** New to us. The number that actually appeared on somebody's screen. */
  imported: number;
  /** Already had them, by webhook or by an earlier pull. Expected, not a fault. */
  duplicates: number;
  /** Of the new ones: landed on a company. */
  matched: number;
  /** Of the new ones: nobody on file has that number. */
  unmatched: number;
  /** Could not be read at all. Recorded on the row, not retried forever. */
  failed: number;
  /** True when the throttle turned this down. Nothing was fetched. */
  skipped?: boolean;
  [key: string]: number | string | boolean | undefined;
}

export interface PullOptions {
  /** How far back to look. RingCentral keeps its own rolling window. */
  sinceHours?: number;
  /** Cap on records taken in one pass. */
  limit?: number;
}

/**
 * How long since the pull job last ran, in seconds. Null if it never has.
 *
 * Read from job_runs rather than from a module variable, because the throttle
 * has to hold across serverless instances. A variable in memory throttles one
 * instance and lets the other nine through, which is not a throttle.
 */
export async function secondsSinceLastPull(db: Db): Promise<number | null> {
  const rows = await db.execute<{ age: string | null }>(sql`
    select extract(epoch from (now() - max(started_at)))::text as age
      from job_runs
     where job = 'pull-recent-calls'
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  const age = (list[0] as { age?: string | null })?.age;
  return age == null ? null : Number(age);
}

/**
 * Fetch the recent call log and push every call through the pipeline.
 *
 * The counts come back rather than being logged and forgotten, because the
 * screen that presses this button needs to say something true afterwards. "24
 * calls, 3 new, 1 nobody recognised" answers the question somebody actually
 * has; "done" does not.
 */
export async function importRecentCalls(
  db: Db,
  { sinceHours = 24, limit = 250 }: PullOptions = {},
): Promise<PullSummary> {
  const { fetchCallLog } = await import("@/lib/ringcentral/client");
  const calls = await fetchCallLog({ sinceHours, limit });

  const summary: PullSummary = {
    fetched: calls.length,
    imported: 0,
    duplicates: 0,
    matched: 0,
    unmatched: 0,
    failed: 0,
  };

  for (const call of calls) {
    try {
      const payload = buildCallLogPayload({
        telephonySessionId: call.telephonySessionId,
        counterpartyNumber: call.counterpartyNumber,
        ourNumber: call.ourNumber || undefined,
        direction: call.direction,
        durationSeconds: call.durationSeconds,
        result: call.result,
        startTime: call.startTime,
        // undefined rather than null, so the builder applies its own default of
        // "101" -- RingCentral's convention for the first extension on an
        // account, and what a record with no extension at all almost always is.
        extensionId: call.extensionId ?? undefined,
        contactName: call.contactName,
      });

      const stored = await storeRawEvent(
        db,
        "ringcentral",
        extractExternalId(payload, "ringcentral"),
        payload,
      );

      /*
       * ALWAYS process, even a payload we have seen before.
       *
       * -------------------------------------------------------------------
       * This used to `continue` on a duplicate, and that made the pull
       * incapable of fixing the one thing it exists to fix.
       *
       * Storing and filing are two steps. An event can be written down and
       * then fail to become anything -- the matcher threw, a column was
       * missing, a deploy landed mid-flight -- and after that the payload IS
       * on disk, so every later pull saw a duplicate, said "already here",
       * and skipped the very row that needed filing. The call was in the
       * database and on no screen, and pressing the button again could never
       * help. Which is exactly what it looked like: "RingCentral had 1, and
       * every one was already here", next to an empty dock.
       *
       * processRawEvent returns early on an event that really is filed, so
       * this costs one indexed read in the common case and rescues the
       * uncommon one.
       * -------------------------------------------------------------------
       */
      const outcome = await processRawEvent(db, stored.id);

      if (outcome.status === "already_processed" || outcome.status === "duplicate") {
        summary.duplicates += 1;
        continue;
      }

      // Counted as imported whether or not the PAYLOAD was new, because what
      // this number is read for is "how many calls appeared", and a rescued
      // one appears exactly as much as a fresh one does.
      summary.imported += 1;
      if (outcome.status === "matched") summary.matched += 1;
      else if (outcome.status === "unmatched") summary.unmatched += 1;
    } catch (err) {
      // One bad record must not lose the other two hundred. RingCentral's log
      // is not uniform -- a call with no counterparty number, an internal
      // transfer, a fax leg -- and any of them throwing would otherwise end the
      // import at whatever point it reached.
      summary.failed += 1;
      log.warn({ err, id: call.telephonySessionId }, "could not import a call");
    }
  }

  /*
   * Put every call with the right person before returning.
   *
   * Cheap and idempotent -- it only touches rows whose credit disagrees with
   * the extension mapping. It belongs here because this is the moment new calls
   * land AND the moment somebody is most likely to have just mapped an
   * extension: the pull now fires when the application opens, so the repair
   * happens without anybody knowing there was something to repair.
   */
  try {
    const { reattributeByExtension } = await import("@/lib/sweep");
    const moved = await reattributeByExtension(db);
    if (moved > 0) log.info({ moved }, "re-credited calls after the pull");
  } catch (err) {
    // A failed repair must not lose the import that just succeeded.
    log.warn({ err }, "could not re-credit calls after the pull");
  }

  log.info(summary, "pulled the call log");
  return summary;
}

/**
 * One sentence about what just happened, for somebody looking at a screen.
 *
 * Written here rather than in the button so the job, the admin screen and the
 * dock all say the same thing, and so the wording can be argued about in one
 * place. Every branch names what to do next when there is something to do.
 */
export function describePull(s: PullSummary): string {
  if (s.skipped) return "Already checked within the last minute. Nothing to do.";
  if (s.fetched === 0) {
    return "RingCentral has no calls in that window. Make one and press this again.";
  }
  if (s.imported === 0) {
    return `RingCentral had ${s.fetched}, and every one was already here. Nothing was added.`;
  }

  const parts = [`Loaded ${s.imported} new ${s.imported === 1 ? "call" : "calls"} of ${s.fetched}.`];
  if (s.matched > 0) {
    parts.push(`${s.matched} landed on a company and ${s.matched === 1 ? "is" : "are"} waiting to be written up.`);
  }
  if (s.unmatched > 0) {
    parts.push(
      `${s.unmatched} ${s.unmatched === 1 ? "was" : "were"} to a number nobody has on file — ` +
        `say who they were with in the phone dock.`,
    );
  }
  if (s.failed > 0) parts.push(`${s.failed} could not be read.`);
  return parts.join(" ");
}
