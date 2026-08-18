/**
 * Handing a stored call off to be worked out.
 *
 * ===========================================================================
 * THE SHAPE OF THE PROBLEM
 *
 * When a call ends, RingCentral posts to our webhook and expects an answer in
 * well under a second. Miss that and it treats the delivery as failed and sends
 * the same call again, repeatedly. But working out WHICH company a call belongs
 * to -- normalise the number, find the contact, find the account, find the rep,
 * decide whether it qualifies, write it down -- takes longer than that budget.
 *
 * So it happens in two beats. The receiver writes the payload down raw and
 * answers immediately; the interpreting happens after the response has gone.
 *
 * WHAT MAKES BEAT TWO ACTUALLY HAPPEN
 *
 * Nothing, by default. Serverless functions are not machines that stay on: the
 * platform starts one to handle the request and is entitled to stop it the
 * moment the response is sent. Work started and not awaited is work that may be
 * killed mid-sentence -- and the failure is invisible, because the call IS
 * written down, just never filed. No error, no retry, nothing in a log. The
 * first sign is a broker asking why their calls stopped showing up.
 *
 * after() is the framework's answer: it tells the platform to keep the
 * invocation alive until the promise settles. Same request, same process, just
 * not killed at the response. On Vercel it maps to waitUntil; in development it
 * simply runs.
 *
 * WHY NOT A QUEUE SERVICE
 *
 * Alex, asked directly, chose to build it rather than sign up for one, with
 * "as cheaply as possible" as the constraint. That is a real trade and it is
 * worth writing down which way it cuts:
 *
 *   A queue service guarantees the work eventually runs even if this process
 *     dies outright. Cost: another account, another credential to rotate,
 *     another dashboard to remember exists.
 *
 *   after() covers everything except a hard crash between the response and the
 *     write. That gap is covered instead by the sweeper in jobs/registry.ts,
 *     which finds any raw event that never became an activity and finishes it.
 *
 * So the difference is not "safe versus unsafe" -- nothing is lost either way,
 * because the payload is on disk before this function is called. The difference
 * is how long a dropped one takes to recover: seconds with a queue, until the
 * next sweep without one.
 *
 * The Inngest path is kept and still works if INNGEST_EVENT_KEY is ever set. It
 * is no longer required, and nothing in production depends on it.
 * ===========================================================================
 */
import { after } from "next/server";
import { EVENTS, inngest } from "@/inngest/client";
import { db } from "@/lib/db";
import { webhookLog } from "@/lib/logger";
import { processRawEvent } from "@/lib/matcher";

export type QueueKind = "call" | "email";

function inngestConfigured(): boolean {
  return Boolean(process.env.INNGEST_EVENT_KEY);
}

export async function enqueueProcessing(kind: QueueKind, rawEventId: string): Promise<void> {
  if (inngestConfigured()) {
    await inngest.send({
      name: kind === "call" ? EVENTS.callReceived : EVENTS.emailReceived,
      data: { rawEventId },
    });
    return;
  }

  /*
   * Started here, deliberately, before after() is called.
   *
   * If after() is unavailable -- a script, a test, anything outside a request
   * -- the work is already running and the only thing lost is the platform's
   * promise to wait for it. Starting it inside the try instead would mean an
   * unavailable after() silently did nothing at all.
   */
  const work = processRawEvent(db, rawEventId)
    .then((outcome) => {
      webhookLog.debug({ rawEventId, outcome: outcome.status }, "processed after responding");
    })
    .catch((err) => {
      // Swallowed rather than rethrown: an unhandled rejection in a detached
      // promise can take the whole process down, and the sweeper will pick this
      // event up regardless because processed_at is still null.
      webhookLog.error({ rawEventId, err }, "processing failed; left for the sweeper");
    });

  try {
    after(work);
  } catch {
    /*
     * No request context. The simulator and the test suite call this directly,
     * and there is nothing to keep alive in a long-running process anyway.
     */
    void work;
  }
}
