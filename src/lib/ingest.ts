/**
 * The front door: getting an inbound payload safely onto disk.
 *
 * Separated from the webhook route so the simulator, the tests and the real
 * endpoint all take the identical path in. If storing an event behaved even
 * slightly differently in tests, the idempotency guarantee would be untested
 * where it actually matters.
 */
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/matcher";

export interface StoredEvent {
  id: string;
  /** False when this exact event has already been received and stored. */
  isNew: boolean;
}

/**
 * Persist a raw payload verbatim, exactly once.
 *
 * Storing before interpreting is the rule that makes the pipeline debuggable:
 * when a call does not appear on an account, this table is what proves whether
 * the provider ever sent it. Interpretation can be fixed and replayed; a
 * payload that was never written down is gone.
 *
 * Deduplication rides on the partial unique index over (source, external_id).
 * Providers redeliver on any non-2xx, on timeouts, and sometimes for no reason
 * at all, so the second delivery must be a no-op rather than a second call in
 * the customer's timeline.
 *
 * An event with no external_id cannot be deduplicated and is always stored. The
 * unique index is partial precisely so those rows do not collide with each
 * other on a shared NULL.
 */
export async function storeRawEvent(
  db: Db,
  source: string,
  externalId: string | null,
  payload: unknown,
): Promise<StoredEvent> {
  const inserted = await db
    .insert(schema.rawEvents)
    .values({ source, externalId, payload: payload as object })
    .onConflictDoNothing()
    .returning({ id: schema.rawEvents.id });

  if (inserted.length > 0) return { id: inserted[0].id, isNew: true };

  // Conflict: we have seen this one. Return the original row's id so the caller
  // can still report which event the delivery referred to.
  if (externalId) {
    const [existing] = await db
      .select({ id: schema.rawEvents.id })
      .from(schema.rawEvents)
      .where(and(eq(schema.rawEvents.source, source), eq(schema.rawEvents.externalId, externalId)))
      .limit(1);
    if (existing) return { id: existing.id, isNew: false };
  }

  throw new Error(`failed to store raw event for source=${source} externalId=${externalId}`);
}

/**
 * Pull the provider's identifier out of a payload cheaply.
 *
 * This runs inside the webhook's sub-300ms budget, so it reads the couple of
 * places the id actually appears rather than fully parsing the event. Full
 * parsing happens later, in the background job, where time is not scarce.
 */
export function extractExternalId(payload: unknown, source: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const body = (root.body ?? {}) as Record<string, unknown>;

  if (source === "email") {
    return pick(body.messageId) ?? pick(body.id) ?? pick(root.uuid);
  }

  const changes = Array.isArray(body.changes) ? body.changes : [];
  const firstRecord = changes
    .flatMap((c) => {
      const rec = c as Record<string, unknown>;
      return Array.isArray(rec?.newRecords) ? (rec.newRecords as Record<string, unknown>[]) : [];
    })
    .find(Boolean);

  return (
    pick(body.telephonySessionId) ??
    pick(firstRecord?.telephonySessionId) ??
    pick(firstRecord?.sessionId) ??
    pick(body.sessionId) ??
    pick(root.uuid)
  );
}

function pick(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
