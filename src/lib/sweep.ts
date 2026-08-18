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

  if (processed > 0 || failed > 0) {
    log.info({ processed, failed, remaining }, "swept pending events");
  }
  return { processed, failed, remaining };
}
