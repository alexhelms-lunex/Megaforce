import { db } from "@/lib/db";
import { matcherLog } from "@/lib/logger";
import { processRawEvent } from "@/lib/matcher";
import { EVENTS, inngest, type ProcessEventData } from "./client";

/**
 * Turn a stored raw event into an activity, or into a review-queue item.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STEP BOUNDARIES SIT WHERE THEY DO
 *
 * The obvious structure is one step per phase: load, match, qualify, write.
 * That is worse, and it is worth being explicit about why, because it looks
 * like the more careful design.
 *
 * An Inngest step is a CHECKPOINT. Its result is memoised, and on retry every
 * step before the failure is replayed from cache rather than re-executed. That
 * is exactly right for steps that are expensive and side-effect-free. It is
 * actively harmful for a chain where a later step depends on data an earlier
 * step read.
 *
 * Split into four steps, this happens: the match step resolves phone
 * +17045551234 to Acme and caches it. The write step fails on a transient
 * connection error. Between the failure and the retry, an admin fixes a data
 * entry mistake and moves that contact to Globex. On retry, the match step
 * replays from CACHE -- and the call is written to Acme, the account it no
 * longer belongs to. The cache has quietly become a stale read.
 *
 * So the boundary is drawn where the failure modes genuinely differ:
 *
 *   Step 1, "process" -- read, match, qualify and write as a single unit. It
 *     is safe to retry wholesale because idempotency is enforced by the
 *     database, not by the runner: partial unique indexes on
 *     activities(source, external_id) and unmatched_activities(raw_event_id)
 *     mean a replay produces the same one row it produced the first time.
 *     processRawEvent also returns early on an already-processed event, so a
 *     duplicate run is a cheap no-op rather than a second write.
 *
 * That is one step, and the honest count. Adding boundaries that only
 * checkpoint reads would trade a real correctness property for the appearance
 * of granularity.
 *
 * Retries are set to 4. The failures worth retrying here are transient --
 * connection resets, pooler saturation, a brief Supabase restart. A genuinely
 * malformed payload is not retried into success; it is recorded on the
 * raw_events row with its error and left for a human.
 * ---------------------------------------------------------------------------
 */
// Note the shape: Inngest v4 takes (options, handler) with the trigger inside
// options. Older examples use a three-argument form with the trigger in the
// middle; that signature no longer exists.
export const processCall = inngest.createFunction(
  { id: "process-call", retries: 4, triggers: [{ event: EVENTS.callReceived }] },
  async ({ event, step }) => {
    const { rawEventId } = event.data as ProcessEventData;

    const outcome = await step.run("process", () => processRawEvent(db, rawEventId));

    matcherLog.info({ rawEventId, outcome: outcome.status }, "processed call event");
    return outcome;
  },
);

/** Identical pipeline, keyed on email address instead of phone number. */
export const processEmail = inngest.createFunction(
  { id: "process-email", retries: 4, triggers: [{ event: EVENTS.emailReceived }] },
  async ({ event, step }) => {
    const { rawEventId } = event.data as ProcessEventData;
    const outcome = await step.run("process", () => processRawEvent(db, rawEventId));
    matcherLog.info({ rawEventId, outcome: outcome.status }, "processed email event");
    return outcome;
  },
);

/*
 * The subscription renewal cron used to live here.
 *
 * It has moved to jobs/registry.ts, which runs on the cron this project
 * already has. Leaving it here would have meant the one job whose failure is
 * completely silent -- a lapsed subscription stops calls arriving with no error
 * anywhere -- depending on a service that is now optional. See
 * renewCallSubscription for the reasoning.
 */

export const functions = [processCall, processEmail];
