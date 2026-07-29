import { db } from "@/lib/db";
import { extractExternalId, storeRawEvent } from "@/lib/ingest";
import { webhookLog } from "@/lib/logger";
import { enqueueProcessing } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email receiver.
 *
 * Gmail is deliberately not wired up. The lesson and the demo are the
 * match-and-qualify path; OAuth consent screens and IMAP idle loops are neither.
 * This endpoint accepts an email-shaped JSON payload and runs the identical
 * pipeline, keyed on address instead of phone number -- same storage, same
 * idempotency, same review queue for an address found at two accounts.
 *
 * Expected body:
 *   {
 *     "body": {
 *       "messageId": "unique-per-message",
 *       "direction": "inbound" | "outbound",
 *       "from": "someone@customer.test",
 *       "to": ["rep@megaforce.test"],
 *       "subject": "Re: Q3 campaign",
 *       "sentAt": "2026-07-29T15:04:05Z"
 *     }
 *   }
 *
 * Putting a real mail provider behind this later means writing a translator
 * into that shape. Nothing downstream changes.
 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("expected a JSON body", { status: 400 });
  }

  try {
    const externalId = extractExternalId(payload, "email");
    const { id, isNew } = await storeRawEvent(db, "email", externalId, payload);
    if (isNew) await enqueueProcessing("email", id);

    return Response.json({ ok: true, rawEventId: id, duplicate: !isNew });
  } catch (err) {
    webhookLog.error({ err }, "failed to store email event");
    return new Response("error", { status: 500 });
  }
}
