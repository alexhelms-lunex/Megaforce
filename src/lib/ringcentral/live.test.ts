import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "../../../db/drizzle-local";
import type { LocalDb } from "../../../db/local";
import * as schema from "@/lib/db/schema";
import {
  isTelephonyEvent,
  parseTelephonyEvent,
  pruneLiveCalls,
  recordLiveCall,
  type LiveCallEvent,
} from "@/lib/ringcentral/live";

/**
 * The call that is happening right now.
 *
 * ===========================================================================
 * Alex: "If I make a call right now it needs to show there even if the person
 * has not even picked up. with a live second counter."
 *
 * Two things here are easy to get wrong and impossible to notice afterwards.
 *
 * ONE CALL, ONE ROW. A telephony session reports itself repeatedly -- ringing,
 * answered, ended -- all carrying the same session id. If those ever became
 * three rows, a broker would watch one call turn into three on their screen
 * mid-conversation. The test that matters is not "does it insert" but "does the
 * second event REPLACE the first".
 *
 * IT NEVER GOES BACKWARDS. Webhooks arrive out of order under load. A Setup
 * event landing after Disconnected must not resurrect a finished call -- that
 * failure leaves a phantom call ringing on somebody's screen with no way to
 * dismiss it, and it only happens under exactly the load that makes it hardest
 * to reproduce.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;
let repId: string;
let accountId: string;
let contactId: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    delete from live_calls;
    delete from contacts;
    delete from accounts;
    delete from users;
  `);

  const [rep] = await db
    .insert(schema.users)
    .values({ email: "dana@megaforce.test", fullName: "Dana", role: "broker", rcExtensionId: "101" })
    .returning({ id: schema.users.id });
  repId = rep.id;

  const [account] = await db
    .insert(schema.accounts)
    .values({ name: "Tanglewood Milling", status: "prospect", ownerId: repId })
    .returning({ id: schema.accounts.id });
  accountId = account.id;

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId,
      firstName: "Priya",
      lastName: "Raman",
      phoneE164: "+17045550142",
    })
    .returning({ id: schema.contacts.id });
  contactId = contact.id;
});

/** The shape RingCentral posts for a telephony session. */
function sessionEvent(
  statusCode: string,
  options: {
    direction?: "Outbound" | "Inbound";
    extensionId?: string | null;
    sessionId?: string;
    /**
     * Defaults to NOW, not to a fixed instant.
     *
     * ended_at is taken from RingCentral's own event time, and the pruner works
     * in real time against it -- so a fixture stamped at a fixed hour is a call
     * that ended however long ago the suite happens to be running, and the
     * "only just ended" case would pass or fail depending on the clock.
     */
    at?: string;
  } = {},
) {
  const {
    direction = "Outbound",
    extensionId = "101",
    sessionId = "sess-1",
    at = new Date().toISOString(),
  } = options;
  const us = { phoneNumber: "+13234855857", name: "MegaCorp" };
  const them = { phoneNumber: "+17045550142", name: "Priya Raman" };

  return {
    event: "/restapi/v1.0/account/11111/telephony/sessions",
    body: {
      telephonySessionId: sessionId,
      eventTime: at,
      parties: [
        {
          ...(extensionId ? { extensionId } : {}),
          direction,
          status: { code: statusCode },
          from: direction === "Outbound" ? us : them,
          to: direction === "Outbound" ? them : us,
        },
      ],
    },
  };
}

async function liveRows() {
  const { rows } = await pg.query<{
    telephony_session_id: string;
    state: string;
    user_id: string | null;
    extension_id: string | null;
    account_id: string | null;
    contact_id: string | null;
    counterparty_number: string | null;
    answered_at: string | null;
    ended_at: string | null;
  }>(`select * from live_calls order by started_at`);
  return rows;
}

// ===========================================================================
describe("telling a live call apart from a finished one", () => {
  it("recognises a telephony session event", () => {
    expect(isTelephonyEvent(sessionEvent("Setup"))).toBe(true);
  });

  it("does not mistake a call log record for one", () => {
    // These take completely different roads -- one upserts, the other is stored
    // and deduplicated. Confusing them silently breaks whichever gets the wrong
    // treatment, with no error anywhere.
    const callLog = {
      event: "/restapi/v1.0/account/11111/extension/101/call-log-sync",
      body: { changes: [{ newRecords: [{ id: "abc", telephonySessionId: "sess-1" }] }] },
    };
    expect(isTelephonyEvent(callLog)).toBe(false);
  });
});

// ===========================================================================
describe("reading who is on the call", () => {
  it("takes the counterparty from `to` on an outbound call", () => {
    const parsed = parseTelephonyEvent(sessionEvent("Answered", { direction: "Outbound" }));
    expect(parsed?.counterpartyNumber).toBe("+17045550142");
    expect(parsed?.ourNumber).toBe("+13234855857");
  });

  it("takes it from `from` on an inbound one", () => {
    // The half that a naive reader gets wrong: reading `to` always would put
    // our own switchboard number on every inbound call, and then nothing would
    // ever match a contact.
    const parsed = parseTelephonyEvent(sessionEvent("Answered", { direction: "Inbound" }));
    expect(parsed?.counterpartyNumber).toBe("+17045550142");
    expect(parsed?.ourNumber).toBe("+13234855857");
  });

  it("picks OUR party out of a session, not simply the first one", () => {
    const event = sessionEvent("Answered");
    // The customer's leg listed first, as RingCentral often does.
    event.body.parties.unshift({
      direction: "Inbound",
      status: { code: "Answered" },
      from: { phoneNumber: "+17045550142", name: "Priya Raman" },
      to: { phoneNumber: "+13234855857", name: "MegaCorp" },
    } as (typeof event.body.parties)[number]);

    const parsed = parseTelephonyEvent(event);
    expect(parsed?.extensionId).toBe("101");
  });

  it("collapses RingCentral's many statuses to the three a person needs", () => {
    expect(parseTelephonyEvent(sessionEvent("Setup"))?.state).toBe("ringing");
    expect(parseTelephonyEvent(sessionEvent("Proceeding"))?.state).toBe("ringing");
    expect(parseTelephonyEvent(sessionEvent("Answered"))?.state).toBe("answered");
    expect(parseTelephonyEvent(sessionEvent("Disconnected"))?.state).toBe("ended");
  });

  it("treats an unrecognised status as still in progress, not as over", () => {
    // The safe direction. A new status code we have never seen must not make a
    // call in progress vanish from the caller's screen.
    expect(parseTelephonyEvent(sessionEvent("Parked"))?.state).toBe("ringing");
  });
});

// ===========================================================================
describe("one call, one row", () => {
  async function push(statusCode: string, options?: Parameters<typeof sessionEvent>[1]) {
    const parsed = parseTelephonyEvent(sessionEvent(statusCode, options));
    await recordLiveCall(db, parsed as LiveCallEvent);
  }

  it("replaces the row as the call progresses rather than adding to it", async () => {
    await push("Setup");
    await push("Answered");
    await push("Disconnected");

    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("ended");
  });

  it("credits the call to whoever owns that extension", async () => {
    await push("Answered");
    const [row] = await liveRows();
    expect(row.user_id).toBe(repId);
    expect(row.extension_id).toBe("101");
  });

  it("keeps a call from an extension nobody has claimed", async () => {
    // Not an error state. It is the state every account is in before the
    // extensions are mapped, and losing the call would be far worse than
    // showing it to nobody for a while.
    await push("Answered", { extensionId: "907", sessionId: "sess-orphan" });
    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].extension_id).toBe("907");
    expect(rows[0].user_id).toBeNull();
  });

  it("finds the company from the number, so the dock shows a name not digits", async () => {
    await push("Answered");
    const [row] = await liveRows();
    expect(row.account_id).toBe(accountId);
    expect(row.contact_id).toBe(contactId);
  });

  it("records a call to a number nobody has on file", async () => {
    const parsed = parseTelephonyEvent(sessionEvent("Answered", { sessionId: "sess-2" }));
    await recordLiveCall(db, { ...(parsed as LiveCallEvent), counterpartyNumber: "+15555550137" });

    const row = (await liveRows()).find((r) => r.telephony_session_id === "sess-2");
    expect(row?.account_id).toBeNull();
    expect(row?.counterparty_number).toBe("+15555550137");
  });
});

// ===========================================================================
describe("events that arrive out of order", () => {
  async function push(statusCode: string) {
    const parsed = parseTelephonyEvent(sessionEvent(statusCode));
    await recordLiveCall(db, parsed as LiveCallEvent);
  }

  it("does not let a late 'ringing' resurrect a call that has ended", async () => {
    /*
     * The one that produces a phantom.
     *
     * Under load a Setup event can land after Disconnected. Applied blindly it
     * flips a finished call back to ringing, and since nothing ever ends it
     * again the broker is left with a call in progress on their screen that
     * they cannot dismiss.
     */
    await push("Answered");
    await push("Disconnected");
    await push("Setup");

    const [row] = await liveRows();
    expect(row.state).toBe("ended");
    expect(row.ended_at).not.toBeNull();
  });

  it("never forgets when they picked up", async () => {
    // The second counter runs from answered_at. Losing it restarts the timer
    // mid-call, which tells a broker they are at forty seconds when they are
    // past the sixty the policy turns on.
    await push("Answered");
    const answeredAt = (await liveRows())[0].answered_at;
    expect(answeredAt).not.toBeNull();

    await push("Disconnected");
    expect((await liveRows())[0].answered_at).toEqual(answeredAt);
  });

  it("leaves answered_at empty for a call nobody picked up", async () => {
    // A call that rang out has no talk time, and inventing one would put a
    // duration on a conversation that never happened.
    await push("Setup");
    await push("Disconnected");

    const [row] = await liveRows();
    expect(row.answered_at).toBeNull();
    expect(row.state).toBe("ended");
  });
});

// ===========================================================================
describe("clearing up", () => {
  it("forgets calls that ended a while ago", async () => {
    await recordLiveCall(db, parseTelephonyEvent(sessionEvent("Disconnected")) as LiveCallEvent);
    await pg.exec(`update live_calls set ended_at = now() - interval '30 minutes'`);

    expect(await pruneLiveCalls(db)).toBe(1);
    expect(await liveRows()).toHaveLength(0);
  });

  it("keeps one that only just ended, so the dock can show it", async () => {
    await recordLiveCall(db, parseTelephonyEvent(sessionEvent("Disconnected")) as LiveCallEvent);
    expect(await pruneLiveCalls(db)).toBe(0);
    expect(await liveRows()).toHaveLength(1);
  });

  it("closes a call that never ended at all", async () => {
    // The Disconnected event never arrived -- a dropped webhook, a lapsed
    // subscription, a deploy mid-call. Left alone it shows as in progress for
    // days.
    await recordLiveCall(db, parseTelephonyEvent(sessionEvent("Answered")) as LiveCallEvent);
    await pg.exec(`update live_calls set started_at = now() - interval '6 hours'`);

    expect(await pruneLiveCalls(db)).toBe(1);
    expect(await liveRows()).toHaveLength(0);
  });
});
