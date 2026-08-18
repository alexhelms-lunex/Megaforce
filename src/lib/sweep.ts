import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { processRawEvent, type Db } from "@/lib/matcher";

/**
 * Finish any call that was written down but never filed.
 *
 * ===========================================================================
 * WHAT THIS IS UNDER
 *
 * A call arrives, the receiver writes the raw payload down, answers
 * RingCentral inside its budget, and works out which company the call belongs
 * to after the response has gone. after() keeps the serverless invocation alive
 * for that -- but a hard crash in between leaves the payload on disk with
 * processed_at still null, and nothing would ever look at it again.
 *
 * Closing that gap is the entire product a queue service sells. Alex chose to
 * build it rather than sign up for one, so this is the half that has to exist:
 * find anything that never finished, and finish it.
 *
 * Nothing is lost either way -- the payload is stored before any of this -- so
 * the only question is how long a dropped call takes to appear. Seconds with a
 * queue service; until the next sweep without one.
 *
 * TAKES A Db RATHER THAN IMPORTING ONE
 *
 * Same shape as processRawEvent, and for the same reason: it makes this
 * testable against a real Postgres in-process, which is the only way to prove
 * the idempotency guarantees underneath it. A module that reaches for the
 * global connection can only be tested by faking the database, and a faked
 * database happily accepts the duplicate writes this is supposed to avoid.
 * ===========================================================================
 */

const log = logger.child({ component: "sweep" });

export interface SweepResult {
  /** Turned into activity, or into a review-queue item. */
  processed: number;
  /** Threw. The error is recorded on the row, so they are not retried forever. */
  failed: number;
  /** Still eligible after this pass. Non-zero means the batch limit was hit. */
  remaining: number;
  /** Marked done, but nothing was ever produced. Re-filed by this pass. */
  rescued: number;
}

export interface SweepOptions {
  /**
   * How old an event must be before it is swept, in minutes.
   *
   * An event received seconds ago is very likely still being processed right
   * now by the request that received it. Sweeping it would run the matcher
   * twice on the same payload concurrently -- which is SAFE, since
   * processRawEvent returns early on an already-processed event and the unique
   * indexes on activities(source, external_id) and
   * unmatched_activities(raw_event_id) make a duplicate write impossible -- but
   * it is wasted work, and it fills the log with races that look alarming and
   * are not. Five minutes is far longer than the work takes and far shorter
   * than anybody would notice.
   */
  olderThanMinutes?: number;
  /**
   * How many to take in one pass.
   *
   * A backlog is exactly when this matters and exactly when it is dangerous. If
   * the webhook has been failing for a day there could be thousands waiting,
   * and a job that tries to clear all of them in one cron run hits the function
   * timeout and clears NONE -- then does the same tomorrow. A bounded batch
   * always finishes, and `remaining` lets the screen say the backlog is
   * shrinking rather than leaving somebody guessing.
   */
  limit?: number;
}

/** Normalised because Drizzle's execute returns an array on some drivers. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | null)?.rows ?? [];
}

export async function sweepRawEvents(
  db: Db,
  { olderThanMinutes = 5, limit = 200 }: SweepOptions = {},
): Promise<SweepResult> {
  /*
   * The interval is built as a literal rather than bound as a parameter.
   *
   * Postgres will not accept a placeholder inside an interval literal, and
   * `now() - $1::interval` binds a string that has to be parsed at runtime.
   * The value never comes from a user -- it is a number this file controls --
   * and it is forced through Math.round so it cannot carry anything else.
   */
  const minutes = Math.max(0, Math.round(olderThanMinutes));
  const cutoff = sql.raw(`now() - interval '${minutes} minutes'`);
  const batch = Math.max(1, Math.min(Math.round(limit), 1000));

  const pending = rowsOf<{ id: string }>(
    await db.execute(sql`
      select id from raw_events
       where processed_at is null
         and error is null
         and received_at < ${cutoff}
       order by received_at
       limit ${batch}
    `),
  );

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await processRawEvent(db, row.id);
      processed += 1;
    } catch (err) {
      // One unreadable payload must not stop the sweep. processRawEvent records
      // the error on the row itself, so it drops out of the query above next
      // time rather than being retried forever.
      failed += 1;
      log.warn({ rawEventId: row.id, err }, "could not process a pending event");
    }
  }

  const remaining = Number(
    rowsOf<{ n: string }>(
      await db.execute(sql`
        select count(*)::text as n from raw_events
         where processed_at is null and error is null and received_at < ${cutoff}
      `),
    )[0]?.n ?? 0,
  );

  const rescued = await refileOrphans(db, batch);

  if (processed > 0 || failed > 0 || rescued > 0) {
    log.info({ processed, failed, remaining, rescued }, "swept pending events");
  }
  return { processed, failed, remaining, rescued };
}

/**
 * Events marked done that produced nothing at all.
 *
 * ===========================================================================
 * THE GAP BETWEEN "PROCESSED" AND "VISIBLE"
 *
 * The sweep above rescues an event that was never processed. This rescues the
 * other kind, which is worse because nothing anywhere reports it: an event with
 * processed_at SET and no activity and no review-queue row behind it.
 *
 * A call in that state is in the database, absent from every screen, and
 * unreachable by every repair path in the system. processRawEvent returns early
 * on a processed event, the sweep's query excludes it, and the call-log pull saw
 * its payload already stored and skipped it. Pressing every button on the admin
 * screen changed nothing, forever.
 *
 * It happens for ordinary reasons. A schema change applied to the code but not
 * yet to the database makes every insert fail; a partial deploy files an event
 * with a matcher that could not write. Both leave the row looking finished.
 *
 * So: find the ones with nothing behind them, clear the mark, and put them back
 * through. Safe to run repeatedly -- an event that files successfully this time
 * stops matching the query, and one that genuinely produced nothing (a
 * cancelled call, an event type we do not turn into anything) is retried at the
 * cost of one parse per sweep and recorded as an error if it is truly
 * unparseable.
 * ===========================================================================
 */
async function refileOrphans(db: Db, limit: number): Promise<number> {
  const orphans = rowsOf<{ id: string }>(
    await db.execute(sql`
      select r.id
        from raw_events r
       where r.processed_at is not null
         and r.error is null
         and not exists (select 1 from activities a where a.raw_event_id = r.id)
         and not exists (select 1 from unmatched_activities m where m.raw_event_id = r.id)
       order by r.received_at desc
       limit ${limit}
    `),
  );

  let rescued = 0;
  for (const row of orphans) {
    try {
      // Clearing the mark is what makes processRawEvent willing to look at it
      // again; it returns early on anything already stamped.
      await db.execute(sql`update raw_events set processed_at = null where id = ${row.id}`);
      const outcome = await processRawEvent(db, row.id);
      if (outcome.status === "matched" || outcome.status === "unmatched") rescued += 1;
    } catch (err) {
      log.warn({ rawEventId: row.id, err }, "could not re-file an orphaned event");
    }
  }
  return rescued;
}
