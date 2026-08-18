import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { storeRawEvent, extractExternalId } from "@/lib/ingest";
import { processRawEvent } from "@/lib/matcher";
import { buildCallLogPayload } from "@/lib/ringcentral/payloads";

/**
 * A call, without a phone system.
 *
 * ===========================================================================
 * WHAT THIS IS AND IS NOT
 *
 * It does NOT talk to RingCentral. No account, no credentials, no signup,
 * nothing over the network. It builds the exact payload RingCentral's Call Log
 * Sync webhook sends and pushes it in through the same front door a real call
 * comes through -- storeRawEvent, then processRawEvent. Every step after that
 * is the real one: the phone number is normalised by the real normaliser,
 * matched to a contact by the real matcher, credited to a rep by the real
 * extension lookup, and judged by the real qualifier against the real rules.
 *
 * So it is not a mock of the pipeline. It is the pipeline, fed by hand.
 *
 * WHY IT EARNS ITS PLACE IN THE PRODUCT
 *
 * Two reasons, and the first one is not "for demos".
 *
 * Once RingCentral IS connected, this is how somebody answers "is the problem
 * my phone system or my CRM?" -- fire one of these, and if it lands correctly
 * then everything downstream of the webhook is fine and the fault is upstream.
 * Without it, that question takes an afternoon.
 *
 * And it means the call-logging story can be shown, argued about and corrected
 * before anybody signs a phone contract. Deciding whether the qualification
 * rules are right is much easier when you can watch a call fail one.
 *
 * WHY THE THREE KINDS
 *
 * They are the three outcomes that exist, and the middle one is the one the
 * whole design is about:
 *
 *   connected  long enough, answered -- arrives NOT counting, because nobody
 *              has written it up. Write it up and it counts. This is the
 *              control: the phone proves it happened, the broker says what
 *              was said, and neither alone is enough.
 *   brief      answered, too short. Can never count, however it is written up.
 *   unknown    a number on no contact record. Lands in the review queue rather
 *              than being dropped, because a call nobody can attribute is
 *              still evidence that somebody called.
 * ===========================================================================
 */

const log = logger.child({ component: "demo-call" });

export type DemoCallKind = "connected" | "brief" | "unknown";

export interface DemoCallResult {
  ok: boolean;
  /** One sentence, written for somebody watching a screen, not reading a log. */
  message: string;
  /** Where to go and look at what just happened. */
  href?: string;
}

interface Target {
  accountId: string;
  accountName: string;
  contactName: string;
  phone: string;
  extension: string | null;
}

/**
 * Somebody real to have called.
 *
 * Prefers a contact on an account the person demonstrating actually holds, so
 * the call lands on THEIR screen rather than somewhere they have to go hunting
 * for. Falls back to any contact with a number, because a fresh database may
 * have given them nothing.
 */
async function pickTarget(userId: string | null): Promise<Target | null> {
  const rows = await db.execute<{
    account_id: string;
    account_name: string;
    contact_name: string;
    phone: string;
    extension: string | null;
  }>(sql`
    select a.id           as account_id,
           a.name         as account_name,
           c.first_name || ' ' || c.last_name as contact_name,
           c.phone_e164   as phone,
           u.rc_extension_id as extension
      from contacts c
      join accounts a on a.id = c.account_id
      left join users u on u.id = a.owner_id
     where c.phone_e164 is not null and c.phone_e164 <> ''
     order by (a.owner_id is not distinct from ${userId}::uuid) desc, random()
     limit 1
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  const row = list[0] as Target & Record<string, string | null>;
  if (!row) return null;

  return {
    accountId: String(row.account_id),
    accountName: String(row.account_name),
    contactName: String(row.contact_name),
    phone: String(row.phone),
    extension: row.extension ? String(row.extension) : null,
  };
}

export async function simulateCall(
  kind: DemoCallKind,
  userId: string | null,
  /** Injected so the id is stable in tests; a real call gets the clock. */
  now: number = Date.now(),
): Promise<DemoCallResult> {
  const target = await pickTarget(userId);

  if (!target && kind !== "unknown") {
    return {
      ok: false,
      message:
        "There are no contacts with a phone number on file, so there is nobody for a call to " +
        "have been with. Add a contact to a company first.",
    };
  }

  /*
   * A number belonging to nobody, for the review-queue case.
   *
   * 555-01xx is the range reserved for fiction precisely so it cannot ring a
   * real person. Using a plausible-looking real number in a demo is how a
   * stranger gets called by somebody following up on it later.
   */
  const phone = kind === "unknown" ? "+15555550137" : target!.phone;

  const payload = buildCallLogPayload({
    // Prefixed and timestamped: identifiable later, and unique so pressing the
    // button twice produces two calls rather than one silent duplicate.
    telephonySessionId: `sim-${kind}-${now}`,
    counterpartyNumber: phone,
    direction: "Outbound",
    durationSeconds: kind === "brief" ? 25 : 214,
    result: "Call connected",
    startTime: new Date(now),
    extensionId: target?.extension ?? "101",
    contactName: kind === "unknown" ? "" : target!.contactName,
  });

  const { id } = await storeRawEvent(
    db,
    "ringcentral",
    extractExternalId(payload, "ringcentral"),
    payload,
  );
  const outcome = await processRawEvent(db, id);

  log.info({ kind, outcome: outcome.status }, "simulated a call");

  switch (outcome.status) {
    case "matched":
      return {
        ok: true,
        href: `/accounts/${outcome.accountId}?tab=activity`,
        message: outcome.qualifies
          ? `Landed on ${target!.accountName} and counted straight away.`
          : `Landed on ${target!.accountName} — ${
              kind === "brief"
                ? "25 seconds, so it will never count however it is written up."
                : "3m 34s, not written up yet, so it is not holding the clock. Write it up in the dock and watch it start counting."
            }`,
      };
    case "unmatched":
      return {
        ok: true,
        href: "/review",
        message:
          "Nobody on file has that number, so it went to the review queue instead of being " +
          "dropped. Somebody who recognises it can attribute it there.",
      };
    case "duplicate":
    case "already_processed":
      return { ok: true, message: "That exact call had already been recorded. Nothing was added." };
    case "unparseable":
      return { ok: false, message: `The pipeline could not read it: ${outcome.detail}` };
  }
}

/**
 * Take the simulated calls back out.
 *
 * Demo data in a database somebody later starts using for real is a problem
 * that arrives months later disguised as a reporting bug. Every simulated call
 * carries a `sim-` external id, so they can all be found and removed exactly --
 * and nothing else can be caught by mistake.
 */
export async function clearSimulatedCalls(): Promise<number> {
  /*
   * Three statements, in this order, and the order is not stylistic.
   *
   * unmatched_activities carries a foreign key to raw_events, so the queue
   * rows have to go before the events they point at or the delete is refused.
   * And it cannot be one statement with CTEs: every CTE in a statement sees the
   * same snapshot, so a `where raw_event_id not in (select id from raw_events)`
   * sitting beside a delete from raw_events matches nothing at all -- the rows
   * are still there as far as it is concerned.
   */
  await db.execute(sql`
    delete from unmatched_activities
     where raw_event_id in (
       select id from raw_events where source = 'ringcentral' and external_id like 'sim-%'
     )
  `);

  await db.execute(sql`
    delete from activities where source = 'ringcentral' and external_id like 'sim-%'
  `);

  const rows = await db.execute<{ n: string }>(sql`
    with gone as (
      delete from raw_events
       where source = 'ringcentral' and external_id like 'sim-%'
      returning id
    )
    select count(*)::text as n from gone
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return Number((list[0] as { n?: string })?.n ?? 0);
}
