import { db } from "@/lib/db";
import { extractExternalId, storeRawEvent } from "@/lib/ingest";
import { webhookLog } from "@/lib/logger";
import { enqueueProcessing } from "@/lib/queue";
import { isTelephonyEvent, parseTelephonyEvent, recordLiveCall } from "@/lib/ringcentral/live";
import { webhookToken } from "@/lib/ringcentral/client";

// postgres.js needs a real Node runtime, not the edge one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RingCentral webhook receiver.
 *
 * This endpoint does four things and deliberately nothing else. Budget: under
 * 300ms, every time.
 *
 *   1. Echo the validation token, so the subscription can activate.
 *   2. Write the payload down verbatim, before anything interprets it.
 *   3. Hand the id to the background worker.
 *   4. Return 200.
 *
 * Matching, qualification and account lookup all happen later. The reason is
 * not tidiness -- it is that a provider treats a slow response as a failure and
 * redelivers. Doing the work inline means the endpoint occasionally exceeds the
 * timeout, which manufactures duplicate deliveries, which the system then has
 * to defend against. The fast path is what keeps the duplicate rate near zero
 * in the first place.
 */
export async function POST(req: Request) {
  // --- 1. Handshake --------------------------------------------------------
  // On the very first request RingCentral sends a Validation-Token header. It
  // must come back in the RESPONSE header with a 200, or the subscription never
  // activates and no calls are ever delivered. There is no retry and no error
  // message; it simply never works.
  const validationToken = req.headers.get("validation-token");
  if (validationToken) {
    webhookLog.info("responding to RingCentral subscription handshake");
    return new Response(null, {
      status: 200,
      headers: { "Validation-Token": validationToken },
    });
  }

  // --- Authenticity --------------------------------------------------------
  // The verification token is chosen by us when the subscription is created and
  // echoed on every delivery. Without this check the endpoint accepts a call
  // record from anyone who finds the URL.
  //
  // Derived through webhookToken(), NOT read raw from the environment, because
  // that is what was registered with RingCentral -- it refuses a token with
  // punctuation or length, so the secret is hashed before being sent. Comparing
  // against the raw secret here would reject every genuine call as a forgery.
  const expected = webhookToken();
  if (expected) {
    const presented = req.headers.get("verification-token");
    if (presented !== expected) {
      webhookLog.warn("rejected webhook with a bad verification token");
      return new Response("unauthorized", { status: 401 });
    }
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // A body we cannot parse is not worth a retry, so it gets a 200 rather than
    // a 4xx. Returning an error would put the provider into a redelivery loop
    // over a payload that will never parse.
    webhookLog.warn("received an unparseable webhook body");
    return new Response("ok", { status: 200 });
  }

  try {
    /*
     * --- 2a. A call in progress takes a different road ---------------------
     *
     * Telephony session events describe ONE call repeatedly -- ringing, then
     * answered, then ended -- every event carrying the same session id. Sent
     * through storeRawEvent they would collide on the (source, external_id)
     * unique index, so only the first would survive and the call would show as
     * ringing forever. They upsert a single row instead, keyed on the session.
     *
     * No activity is created here and the qualifier is not consulted. The
     * completed record arrives separately from RingCentral's call log, with the
     * duration and result that a ringing phone does not have yet.
     */
    if (isTelephonyEvent(payload)) {
      const event = parseTelephonyEvent(payload);
      if (event) {
        await recordLiveCall(db, event);
        return new Response("ok", { status: 200 });
      }
      webhookLog.warn("received a telephony event with no readable session");
      return new Response("ok", { status: 200 });
    }

    // --- 2b. Store first, interpret later ---------------------------------
    const externalId = extractExternalId(payload, "ringcentral");
    const { id, isNew } = await storeRawEvent(db, "ringcentral", externalId, payload);

    // --- 3. Hand off, only if this is genuinely new -----------------------
    // The unique index on (source, external_id) already rejected the duplicate.
    // Not enqueuing here saves the worker a wasted run on every redelivery.
    if (isNew) {
      await enqueueProcessing("call", id);
    } else {
      webhookLog.debug({ externalId }, "ignored a redelivered event");
    }

    // --- 4. Acknowledge ---------------------------------------------------
    return new Response("ok", { status: 200 });
  } catch (err) {
    // A 500 here is correct: we failed to store the event, so we WANT the
    // provider to send it again. This is the one failure that should retry.
    webhookLog.error({ err }, "failed to store RingCentral event");
    return new Response("error", { status: 500 });
  }
}

/** Some providers probe with a GET before activating a subscription. */
export async function GET(req: Request) {
  const validationToken = req.headers.get("validation-token");
  if (validationToken) {
    return new Response(null, { status: 200, headers: { "Validation-Token": validationToken } });
  }
  return new Response("ringcentral webhook receiver", { status: 200 });
}
