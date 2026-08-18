import { sql } from "drizzle-orm";
import { toE164 } from "@/lib/phone";
import { logger } from "@/lib/logger";
import type { Db } from "@/lib/matcher";

/**
 * The call that is happening right now.
 *
 * ===========================================================================
 *   "it needs to always be loaded and connected ring central. If I make a call
 *    right now it needs to show there even if the person has not even picked
 *    up. with a live second counter."
 *
 * WHY THIS IS A DIFFERENT ROAD FROM EVERY OTHER EVENT
 *
 * Everything else the CRM ingests is a thing that finished. A telephony session
 * is a thing in progress, and it reports itself repeatedly -- the phone starts
 * ringing, the far end starts ringing, somebody answers, somebody hangs up --
 * every event carrying the SAME telephonySessionId.
 *
 * That is fatal to the normal path. storeRawEvent deduplicates on
 * (source, external_id), which is exactly right for a completed call delivered
 * twice and exactly wrong here: the first event would be stored and every state
 * change after it dropped as a duplicate. The call would show as ringing and
 * stay ringing forever.
 *
 * So these events never touch raw_events. They upsert one row keyed on the
 * session, each event replacing the last -- the opposite rule, for a thing that
 * changes rather than a thing that happened.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not create an activity, and it does not ask the qualifier anything. A
 * ringing phone has no duration and no result, and a call that never connects
 * has no business on a company's timeline. The authoritative record arrives
 * afterwards from RingCentral's own call log, through the ordinary pipeline,
 * carrying the same telephonySessionId -- so the finished call and the live one
 * are recognisably the same call without either pretending to be the other.
 * ===========================================================================
 */

const log = logger.child({ component: "rc-live" });

export type LiveState = "ringing" | "answered" | "ended";

export interface LiveCallEvent {
  telephonySessionId: string;
  extensionId: string | null;
  counterpartyNumber: string | null;
  counterpartyName: string | null;
  ourNumber: string | null;
  direction: "inbound" | "outbound" | null;
  state: LiveState;
  result: string | null;
  at: Date;
}

/** True when this payload is a telephony session event rather than a call log. */
export function isTelephonyEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as Record<string, unknown>;
  const event = typeof root.event === "string" ? root.event : "";
  if (event.includes("/telephony/sessions")) return true;

  // Some deliveries carry no event string; the body shape still says what it is.
  const body = (root.body ?? {}) as Record<string, unknown>;
  return typeof body.telephonySessionId === "string" && Array.isArray(body.parties);
}

/**
 * Turn one telephony session event into the state it describes.
 *
 * RingCentral reports around a dozen party statuses. They are collapsed to
 * three, because three is what a person needs from a phone: is it still
 * ringing, am I talking, is it over. The rest -- Parked, Hold, VoiceMail,
 * Gone -- are distinctions that matter to a call-control application and not to
 * somebody about to write up what was said.
 */
export function parseTelephonyEvent(payload: unknown): LiveCallEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const body = (root.body ?? {}) as Record<string, unknown>;

  const sessionId = str(body.telephonySessionId) ?? str(body.sessionId);
  if (!sessionId) return null;

  const parties = Array.isArray(body.parties) ? (body.parties as Record<string, unknown>[]) : [];
  /*
   * OUR party, not simply the first one.
   *
   * A session has a party per leg. The one carrying an extensionId is ours; the
   * other is the customer. Taking parties[0] blindly gets it right about half
   * the time, and the half it gets wrong credits the call to nobody and reads
   * the wrong phone number as the counterparty.
   */
  const ours = parties.find((p) => obj(p.extension)?.id != null || p.extensionId != null) ?? parties[0];
  if (!ours) return null;

  const statusCode = str(obj(ours.status)?.code) ?? "";
  const direction = str(ours.direction)?.toLowerCase();

  /*
   * from/to are relative to OUR party, so on an inbound call the counterparty
   * is `from` and on an outbound call it is `to`. Reading one of them always
   * would put our own number on the row half the time.
   */
  const outbound = direction === "outbound";
  const counterparty = outbound ? obj(ours.to) : obj(ours.from);
  const mine = outbound ? obj(ours.from) : obj(ours.to);

  return {
    telephonySessionId: sessionId,
    extensionId: str(obj(ours.extension)?.id) ?? str(ours.extensionId),
    counterpartyNumber: str(counterparty?.phoneNumber),
    counterpartyName: str(counterparty?.name),
    ourNumber: str(mine?.phoneNumber),
    direction: direction === "inbound" || direction === "outbound" ? direction : null,
    state: toState(statusCode),
    // Only meaningful once it is over; before that "Disconnected because…" has
    // not happened yet and there is nothing honest to put here.
    result: statusCode === "Disconnected" ? (str(obj(ours.status)?.reason) ?? "Disconnected") : null,
    at: new Date(str(body.eventTime) ?? str(ours.startTime) ?? Date.now()),
  };
}

function toState(code: string): LiveState {
  switch (code) {
    case "Answered":
      return "answered";
    case "Disconnected":
    case "Gone":
      return "ended";
    // Setup, Proceeding, Ringing, Hold, Parked and anything unrecognised: the
    // call exists and is not over. "Ringing" is the honest summary, and an
    // unknown code defaulting to over would make live calls vanish mid-call.
    default:
      return "ringing";
  }
}

/**
 * Write the current state of one call.
 *
 * ---------------------------------------------------------------------------
 * ON CONFLICT ... DO UPDATE, because the session id is the identity of the call
 * and every event is a newer description of the same thing.
 *
 * Two guards inside the update, and both exist because webhooks arrive out of
 * order under load:
 *
 *   answered_at is COALESCED, never overwritten. A later event that does not
 *     mention answering must not erase when they picked up -- the second
 *     counter runs from it, and losing it would restart the timer mid-call.
 *
 *   the state NEVER MOVES BACKWARDS. ringing → answered → ended is one-way, so
 *     a delayed Setup landing after Disconnected cannot resurrect a finished
 *     call and leave it ringing on somebody's screen forever.
 *
 * The ordering is compared by RANK rather than by timestamp on purpose. The
 * obvious guard -- ignore anything older than updated_at -- compares RingCentral's
 * clock against ours, and the two disagree by however far the delivery was
 * delayed plus whatever the servers differ by. Rank needs no clocks: a call
 * that has been answered cannot go back to ringing whatever the timestamps say.
 * ---------------------------------------------------------------------------
 */
export async function recordLiveCall(db: Db, event: LiveCallEvent): Promise<void> {
  const phone = event.counterpartyNumber ? toE164(event.counterpartyNumber) : null;

  await db.execute(sql`
    insert into live_calls (
      telephony_session_id, extension_id, user_id,
      counterparty_number, counterparty_name, our_number,
      direction, state, result,
      account_id, contact_id,
      started_at, answered_at, ended_at, updated_at
    )
    select
      ${event.telephonySessionId},
      ${event.extensionId},
      u.id,
      ${phone ?? event.counterpartyNumber},
      ${event.counterpartyName},
      ${event.ourNumber},
      ${event.direction},
      ${event.state},
      ${event.result},
      c.account_id,
      c.id,
      ${event.at},
      ${event.state === "answered" ? event.at : null},
      ${event.state === "ended" ? event.at : null},
      now()
      from (select 1) as _
      -- Both optional. A call from an unmapped extension, or to a number nobody
      -- has on file, is still a call and still has to be recorded.
      left join users u on u.rc_extension_id = ${event.extensionId}
      left join lateral (
        select id, account_id from contacts
         where phone_e164 = ${phone} and ${phone}::text is not null
         limit 1
      ) c on true
    on conflict (telephony_session_id) do update set
      state        = excluded.state,
      result       = coalesce(excluded.result, live_calls.result),
      extension_id = coalesce(excluded.extension_id, live_calls.extension_id),
      user_id      = coalesce(excluded.user_id, live_calls.user_id),
      counterparty_number = coalesce(excluded.counterparty_number, live_calls.counterparty_number),
      counterparty_name   = coalesce(excluded.counterparty_name, live_calls.counterparty_name),
      account_id   = coalesce(excluded.account_id, live_calls.account_id),
      contact_id   = coalesce(excluded.contact_id, live_calls.contact_id),
      answered_at  = coalesce(live_calls.answered_at, excluded.answered_at),
      ended_at     = coalesce(excluded.ended_at, live_calls.ended_at),
      updated_at   = now()
     where array_position(array['ringing','answered','ended'], excluded.state)
        >= array_position(array['ringing','answered','ended'], live_calls.state)
  `);

  log.info(
    { session: event.telephonySessionId, state: event.state, extension: event.extensionId },
    "live call state",
  );
}

/**
 * Forget calls that ended a while ago, and close ones that never ended.
 *
 * Two different faults, one statement, because both produce the same symptom --
 * a row sitting in live_calls forever.
 *
 * A finished call is kept briefly so the dock can show "just ended" rather than
 * having the row vanish the instant somebody hangs up; after that the call log
 * has it and this copy is noise.
 *
 * A call with no ending at all is the interesting one: it means the Disconnected
 * event never arrived -- a dropped webhook, a lapsed subscription, a deploy
 * mid-call. Left alone it shows as a call in progress for days. Four hours is
 * far longer than any real call and far shorter than anybody would tolerate
 * staring at a phantom one.
 */
export async function pruneLiveCalls(db: Db): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    with gone as (
      delete from live_calls
       where (ended_at is not null and ended_at < now() - interval '10 minutes')
          or started_at < now() - interval '4 hours'
      returning telephony_session_id
    )
    select count(*)::text as n from gone
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return Number((list[0] as { n?: string })?.n ?? 0);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
