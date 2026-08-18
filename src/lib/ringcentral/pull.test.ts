import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "../../../db/drizzle-local";
import type { LocalDb } from "../../../db/local";
import * as schema from "@/lib/db/schema";
import { storeRawEvent, extractExternalId } from "@/lib/ingest";
import { processRawEvent } from "@/lib/matcher";
import { buildCallLogPayload } from "@/lib/ringcentral/payloads";
import type { PulledCall } from "@/lib/ringcentral/client";

/**
 * Pulling the call log, against a real Postgres.
 *
 * ===========================================================================
 * WHAT IS BEING PROVED
 *
 * Alex: "This needs to load like calls even when the app wasnt open."
 *
 * The claim this feature rests on is that pulling is SAFE TO REPEAT -- that the
 * cron, the button and the dock can all fetch overlapping windows, on top of
 * calls a webhook already delivered, without a single call appearing twice in
 * anybody's timeline. If that is wrong, the visible symptom is a broker's
 * activity count inflating on its own, which nobody would trace back to here.
 *
 * So the duplicate cases are the point of this file, and the interesting one is
 * the LAST: the same conversation arriving by both roads. That only collapses
 * because both roads key on the telephony session id, and nothing in either
 * type signature would tell you if that stopped being true.
 *
 * RingCentral itself is stubbed. Everything downstream of it -- storeRawEvent,
 * the matcher, the extension lookup, the qualifier -- is the real thing running
 * against real Postgres, which is where the guarantees actually live.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;

/** What the stubbed RingCentral returns on the next fetch. */
let logToReturn: PulledCall[] = [];

vi.mock("@/lib/ringcentral/client", () => ({
  fetchCallLog: async () => logToReturn,
}));

let importRecentCalls: typeof import("@/lib/ringcentral/pull").importRecentCalls;
let describePull: typeof import("@/lib/ringcentral/pull").describePull;
let secondsSinceLastPull: typeof import("@/lib/ringcentral/pull").secondsSinceLastPull;

let repId: string;
let accountId: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
  ({ importRecentCalls, describePull, secondsSinceLastPull } = await import(
    "@/lib/ringcentral/pull"
  ));
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  logToReturn = [];
  await pg.exec(`
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from accounts;
    delete from job_runs;
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

  await db.insert(schema.contacts).values({
    accountId,
    firstName: "Priya",
    lastName: "Raman",
    phoneE164: "+17045550142",
  });
});

function call(overrides: Partial<PulledCall> = {}): PulledCall {
  return {
    telephonySessionId: "s-1000",
    counterpartyNumber: "+17045550142",
    ourNumber: "+13234855857",
    direction: "Outbound",
    durationSeconds: 214,
    result: "Call connected",
    startTime: new Date("2026-08-18T15:00:00Z"),
    extensionId: "101",
    contactName: "Priya Raman",
    ...overrides,
  };
}

async function activities() {
  const { rows } = await pg.query<{
    account_id: string;
    user_id: string;
    duration_seconds: number;
    result: string;
    qualifies: boolean;
    qualification_reason: string;
    source: string;
    external_id: string;
  }>(
    `select account_id, user_id, duration_seconds, result, qualifies,
            qualification_reason, source, external_id from activities`,
  );
  return rows;
}

// ===========================================================================
describe("a call fetched from RingCentral rather than delivered", () => {
  it("lands on the company, credited to the rep whose extension made it", async () => {
    logToReturn = [call()];
    const summary = await importRecentCalls(db);

    expect(summary).toMatchObject({ fetched: 1, imported: 1, matched: 1, duplicates: 0 });

    const rows = await activities();
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(accountId);
    expect(rows[0].user_id).toBe(repId);
    expect(rows[0].duration_seconds).toBe(214);
  });

  it("is indistinguishable from one the webhook delivered", async () => {
    // The whole design rests on there being one pipeline rather than two. A
    // pulled call carrying a different source, or a different id scheme, would
    // silently escape the deduplication the next test depends on.
    logToReturn = [call()];
    await importRecentCalls(db);

    const [row] = await activities();
    expect(row.source).toBe("ringcentral");
    expect(row.external_id).toBe("s-1000");
  });

  it("does NOT count on arrival, however long it was", async () => {
    // The control Alex asked for: the phone proves a call happened, the broker
    // says what was said, and neither alone holds an account open. Pulling must
    // not become a way to bank activity without writing anything up.
    logToReturn = [call()];
    await importRecentCalls(db);

    const [row] = await activities();
    expect(row.qualifies).toBe(false);
    expect(row.qualification_reason).toMatch(/not yet logged/i);
  });

  it("carries the provider's result through verbatim, even an unfamiliar one", async () => {
    // RingCentral's real log is not limited to the handful of results worth
    // naming in a type. Coercing "IP Phone Offline" into "Call connected" would
    // tell the qualifier a call ended in a way it did not.
    logToReturn = [call({ result: "IP Phone Offline" })];
    await importRecentCalls(db);

    const [row] = await activities();
    expect(row.result).toBe("IP Phone Offline");
  });
});

// ===========================================================================
describe("pulling the same window twice", () => {
  it("imports each call once, however many times it is fetched", async () => {
    logToReturn = [call()];
    const first = await importRecentCalls(db);
    const second = await importRecentCalls(db);

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await activities()).toHaveLength(1);
  });

  it("collapses a call that ALSO arrived through the webhook", async () => {
    /*
     * The one that matters, and the one nothing else would catch.
     *
     * A webhook delivers a call at 15:00. The hourly pull fetches a 48 hour
     * window at 15:30 and sees the same conversation again. They must land on
     * the same row -- which happens only because both key on the telephony
     * session id, in ingest.extractExternalId for the webhook and in
     * fetchCallLog for the pull. Nothing in either signature enforces that.
     */
    const delivered = buildCallLogPayload({
      telephonySessionId: "s-1000",
      counterpartyNumber: "+17045550142",
      durationSeconds: 214,
      extensionId: "101",
    });
    const stored = await storeRawEvent(
      db,
      "ringcentral",
      extractExternalId(delivered, "ringcentral"),
      delivered,
    );
    await processRawEvent(db, stored.id);
    expect(await activities()).toHaveLength(1);

    logToReturn = [call()];
    const summary = await importRecentCalls(db);

    expect(summary.duplicates).toBe(1);
    expect(summary.imported).toBe(0);
    expect(await activities()).toHaveLength(1);
  });
});

// ===========================================================================
describe("a call to a number nobody has on file", () => {
  it("goes to the queue rather than being dropped, and remembers whose it was", async () => {
    logToReturn = [call({ telephonySessionId: "s-2000", counterpartyNumber: "+15555550137" })];
    const summary = await importRecentCalls(db);

    expect(summary).toMatchObject({ imported: 1, unmatched: 1, matched: 0 });

    const { rows } = await pg.query<{
      phone_e164: string;
      extension_id: string;
      user_id: string;
    }>(`select phone_e164, extension_id, user_id from unmatched_activities`);

    expect(rows).toHaveLength(1);
    expect(rows[0].phone_e164).toBe("+15555550137");
    // Both, because the dock shows a broker their own unmatched calls by
    // user_id, and an extension nobody has claimed is diagnosed by extension_id.
    expect(rows[0].extension_id).toBe("101");
    expect(rows[0].user_id).toBe(repId);
  });

  it("leaves user_id empty when the extension belongs to nobody", async () => {
    // Not an error state -- it is the state every account is in before somebody
    // maps the extensions. The call still has to be kept.
    logToReturn = [
      call({ telephonySessionId: "s-3000", counterpartyNumber: "+15555550137", extensionId: "907" }),
    ];
    await importRecentCalls(db);

    const { rows } = await pg.query<{ extension_id: string; user_id: string | null }>(
      `select extension_id, user_id from unmatched_activities`,
    );
    expect(rows[0].extension_id).toBe("907");
    expect(rows[0].user_id).toBeNull();
  });
});

// ===========================================================================
describe("one bad record", () => {
  it("does not stop the rest of the import", async () => {
    // RingCentral's log is not uniform. A leg with no usable number must cost
    // one call, not the other two hundred behind it in the batch.
    logToReturn = [
      call({ telephonySessionId: "s-4000", counterpartyNumber: "not a phone number at all" }),
      call({ telephonySessionId: "s-4001" }),
    ];
    const summary = await importRecentCalls(db);

    expect(summary.fetched).toBe(2);
    // The bad one is still STORED and still accounted for -- as an unmatched
    // row, because an unreadable number is a fact about the call rather than a
    // reason to forget it happened.
    expect(summary.imported).toBe(2);
    expect(summary.matched).toBe(1);
    expect(await activities()).toHaveLength(1);
  });
});

// ===========================================================================
describe("the throttle the dock relies on", () => {
  it("reports no previous pull before one has happened", async () => {
    expect(await secondsSinceLastPull(db)).toBeNull();
  });

  it("reports a recent run in seconds, so the dock can decline to pull again", async () => {
    await pg.exec(`insert into job_runs (job, trigger) values ('pull-recent-calls', 'manual')`);
    const age = await secondsSinceLastPull(db);
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(60);
  });

  it("ignores other jobs", async () => {
    // A sweep an hour ago must not convince the dock a call-log pull happened.
    await pg.exec(`insert into job_runs (job, trigger) values ('sweep-pending-events', 'schedule')`);
    expect(await secondsSinceLastPull(db)).toBeNull();
  });
});

// ===========================================================================
describe("what the screen is told afterwards", () => {
  const base = { fetched: 0, imported: 0, duplicates: 0, matched: 0, unmatched: 0, failed: 0 };

  it("says there is nothing there rather than looking broken", () => {
    expect(describePull({ ...base })).toMatch(/no calls in that window/i);
  });

  it("distinguishes 'already had them' from 'found nothing'", () => {
    // These look identical to somebody watching -- no new rows appear -- and
    // they mean completely different things about whether the connection works.
    expect(describePull({ ...base, fetched: 12, duplicates: 12 })).toMatch(/already here/i);
  });

  it("says what to do next when a call needs attributing", () => {
    const said = describePull({ ...base, fetched: 3, imported: 3, matched: 2, unmatched: 1 });
    expect(said).toMatch(/Loaded 3 new calls of 3/);
    expect(said).toMatch(/written up/i);
    expect(said).toMatch(/phone dock/i);
  });

  it("says nothing happened when the throttle turned it down", () => {
    expect(describePull({ ...base, skipped: true })).toMatch(/within the last minute/i);
  });
});
