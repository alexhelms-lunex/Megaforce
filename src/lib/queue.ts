/**
 * Handing a stored event off for background processing.
 *
 * There are two ways this can happen, and the choice is made by configuration
 * rather than by code paths scattered through the app:
 *
 *   With Inngest configured -- the normal case, and what production uses. The
 *     event is published and the job runner takes it from there, with retries,
 *     history, and a dashboard.
 *
 *   Without Inngest -- local development and the call simulator. Processing
 *     runs in the background of the current process instead. The webhook still
 *     returns immediately, so the sub-300ms budget holds and the behaviour a
 *     developer sees matches production.
 *
 * The fallback exists so the pipeline is demonstrable on a laptop with nothing
 * signed up for. It is deliberately NOT a production strategy: a crash between
 * the 200 response and the write would lose the event. That is acceptable when
 * the events come from a simulator you can re-run, and not otherwise -- which
 * is why it refuses to engage in production.
 */
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

  if (process.env.NODE_ENV === "production") {
    // Failing loudly beats silently dropping calls on the floor. If this fires
    // in production, INNGEST_EVENT_KEY is missing from the deployment.
    throw new Error(
      "INNGEST_EVENT_KEY is not set. Refusing to process webhooks in-process in production, " +
        "because a crash between the 200 response and the write would lose the event.",
    );
  }

  // Intentionally not awaited: the caller is a webhook with a response budget.
  void processRawEvent(db, rawEventId)
    .then((outcome) => webhookLog.debug({ rawEventId, outcome: outcome.status }, "processed inline"))
    .catch((err) => webhookLog.error({ rawEventId, err }, "inline processing failed"));
}
