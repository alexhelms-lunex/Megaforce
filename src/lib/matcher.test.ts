import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "../../db/drizzle-local";
import type { LocalDb } from "../../db/local";
import * as schema from "@/lib/db/schema";
import { storeRawEvent, extractExternalId } from "@/lib/ingest";
import { openQueue, processRawEvent, resolveUnmatched } from "@/lib/matcher";
import { buildCallLogPayload, buildEmailPayload, buildTelephonySessionPayload } from "@/lib/ringcentral/payloads";

/**
 * These run against real Postgres -- PGlite, in-process. That matters: the
 * idempotency guarantees under test are partial unique indexes, and a mocked
 * database would happily accept the duplicate writes they exist to reject.
 */

let db: LocalDrizzle;
let pg: LocalDb;

let repId: string;
let otherRepId: string;
let acmeId: string;
let globexId: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  // Ordered DELETEs, children first. unmatched_activities points AT activities
  // once an item is resolved, so it has to go before them.
  //
  // Deliberately not TRUNCATE ... CASCADE: qualification_rules and saved_views
  // carry a users foreign key, so cascading from users silently empties the
  // rules table and every call then fails to qualify for the wrong reason.
  await pg.exec(`
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from opportunities;
    delete from accounts;
    delete from users;
  `);

  [{ id: repId }] = await db
    .insert(schema.users)
    .values({
      email: "dana@megaforce.test",
      fullName: "Dana Whitfield",
      role: "broker",
      rcExtensionId: "101",
    })
    .returning({ id: schema.users.id });

  [{ id: otherRepId }] = await db
    .insert(schema.users)
    .values({ email: "kai@megaforce.test", fullName: "Kai Osei", role: "broker", rcExtensionId: "102" })
    .returning({ id: schema.users.id });

  [{ id: acmeId }] = await db
    .insert(schema.accounts)
    .values({ name: "Acme Home Services", ownerId: repId })
    .returning({ id: schema.accounts.id });

  [{ id: globexId }] = await db
    .insert(schema.accounts)
    .values({ name: "Globex Dental Group", ownerId: otherRepId })
    .returning({ id: schema.accounts.id });
});

/** Store a payload and run it all the way through, as the webhook + job would. */
async function ingest(payload: Record<string, unknown>, source = "ringcentral") {
  const externalId = extractExternalId(payload, source);
  const stored = await storeRawEvent(db, source, externalId, payload);
  return { stored, outcome: await processRawEvent(db, stored.id) };
}

async function addContact(accountId: string, phone: string | null, email?: string) {
  const [row] = await db
    .insert(schema.contacts)
    .values({
      accountId,
      firstName: "Robin",
      lastName: "Vega",
      phoneE164: phone,
      email: email ?? null,
    })
    .returning({ id: schema.contacts.id });
  return row.id;
}

const countActivities = async () =>
  (await db.select().from(schema.activities)).length;

// ---------------------------------------------------------------------------

describe("a call that matches one contact", () => {
  it("becomes a qualifying activity on that account", async () => {
    await addContact(acmeId, "+17045551234");

    const { outcome } = await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-001",
        counterpartyNumber: "+17045551234",
        durationSeconds: 184,
        result: "Call connected",
      }),
    );

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") return;
    expect(outcome.accountId).toBe(acmeId);
    expect(outcome.qualifies).toBe(true);
    expect(outcome.reason).toContain("184s");
  });

  it("matches even when the contact's number was stored in a different format", async () => {
    // The seed writes E.164; this asserts the provider's format collapses onto
    // it. This single behaviour is the most common cause of "my call didn't log".
    await addContact(acmeId, "+17045551234");

    const { outcome } = await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-002",
        counterpartyNumber: "(704) 555-1234 ext. 22",
      }),
    );

    expect(outcome.status).toBe("matched");
  });

  it("attributes the call to the rep at the handling extension", async () => {
    await addContact(acmeId, "+17045551234");
    // Extension 102 is Kai, even though Dana owns the account.
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-003",
        counterpartyNumber: "+17045551234",
        extensionId: "102",
      }),
    );

    const [activity] = await db.select().from(schema.activities);
    expect(activity.userId).toBe(otherRepId);
  });

  it("falls back to the account owner when the extension is unknown", async () => {
    await addContact(acmeId, "+17045551234");
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-004",
        counterpartyNumber: "+17045551234",
        extensionId: "999",
      }),
    );

    const [activity] = await db.select().from(schema.activities);
    expect(activity.userId).toBe(repId);
  });

  it("picks the customer's number, not ours, on an inbound call", async () => {
    await addContact(acmeId, "+17045551234");
    const { outcome } = await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-005",
        counterpartyNumber: "+17045551234",
        ourNumber: "+19195550100",
        direction: "Inbound",
      }),
    );
    expect(outcome.status).toBe("matched");
    const [activity] = await db.select().from(schema.activities);
    expect(activity.direction).toBe("inbound");
  });
});

describe("qualification is recorded, not just applied", () => {
  it("stores a short call as a non-qualifying activity with the reason", async () => {
    await addContact(acmeId, "+17045551234");

    const { outcome } = await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-010",
        counterpartyNumber: "+17045551234",
        durationSeconds: 119,
      }),
    );

    expect(outcome.status).toBe("matched");
    const [activity] = await db.select().from(schema.activities);
    // The call is still logged. It just does not count.
    expect(activity.qualifies).toBe(false);
    expect(activity.qualificationReason).toContain("119s");
    expect(activity.qualificationReason).toContain("120s");
  });

  it("passes at 121 seconds", async () => {
    await addContact(acmeId, "+17045551234");
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-011",
        counterpartyNumber: "+17045551234",
        durationSeconds: 121,
      }),
    );
    const [activity] = await db.select().from(schema.activities);
    expect(activity.qualifies).toBe(true);
  });

  it("logs voicemail without counting it, and says why", async () => {
    await addContact(acmeId, "+17045551234");
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-012",
        counterpartyNumber: "+17045551234",
        durationSeconds: 300,
        result: "Voicemail",
      }),
    );
    const [activity] = await db.select().from(schema.activities);
    expect(activity.qualifies).toBe(false);
    expect(activity.qualificationReason).toContain("Voicemail");
  });

  it("obeys a rule change made in the database, with no code change", async () => {
    await addContact(acmeId, "+17045551234");
    // An admin drops the threshold to 60 seconds.
    await db
      .update(schema.qualificationRules)
      .set({ minDurationSeconds: 60 })
      .where(eq(schema.qualificationRules.activityType, "call"));

    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-013",
        counterpartyNumber: "+17045551234",
        durationSeconds: 90,
      }),
    );

    const [activity] = await db.select().from(schema.activities);
    expect(activity.qualifies).toBe(true);
    expect(activity.qualificationReason).toContain("60s");
  });
});

describe("the account's last activity timestamp", () => {
  it("moves only for a qualifying call", async () => {
    await addContact(acmeId, "+17045551234");

    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-020",
        counterpartyNumber: "+17045551234",
        durationSeconds: 30,
        startTime: new Date("2026-03-01T10:00:00Z"),
      }),
    );
    let [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acmeId));
    // A 30 second call must not make a dormant account look alive.
    expect(account.lastActivityAt).toBeNull();

    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-021",
        counterpartyNumber: "+17045551234",
        durationSeconds: 240,
        startTime: new Date("2026-03-02T10:00:00Z"),
      }),
    );
    [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acmeId));
    expect(account.lastActivityAt?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
  });

  it("never moves backwards when an older call arrives late", async () => {
    await addContact(acmeId, "+17045551234");
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-022",
        counterpartyNumber: "+17045551234",
        durationSeconds: 240,
        startTime: new Date("2026-03-10T10:00:00Z"),
      }),
    );
    // Backfill of an older call -- common after a provider outage.
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-023",
        counterpartyNumber: "+17045551234",
        durationSeconds: 240,
        startTime: new Date("2026-03-01T10:00:00Z"),
      }),
    );

    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acmeId));
    expect(account.lastActivityAt?.toISOString()).toBe("2026-03-10T10:00:00.000Z");
  });
});

describe("duplicate delivery", () => {
  it("creates exactly one activity when the same webhook arrives twice", async () => {
    await addContact(acmeId, "+17045551234");
    const payload = buildCallLogPayload({
      telephonySessionId: "s-030",
      counterpartyNumber: "+17045551234",
    });

    const first = await ingest(payload);
    const second = await ingest(payload);

    expect(first.outcome.status).toBe("matched");
    expect(first.stored.isNew).toBe(true);
    // Deduplicated at the front door: the second delivery never even becomes a
    // new raw event, so the job never runs a second time.
    expect(second.stored.isNew).toBe(false);
    expect(second.outcome.status).toBe("already_processed");
    expect(await countActivities()).toBe(1);
  });

  it("still creates one activity if the job is replayed against the same event", async () => {
    // Job runners retry. Reprocessing an event that already produced an activity
    // must not produce a second one, even when the front-door guard is bypassed.
    await addContact(acmeId, "+17045551234");
    const { stored } = await ingest(
      buildCallLogPayload({ telephonySessionId: "s-031", counterpartyNumber: "+17045551234" }),
    );

    await db
      .update(schema.rawEvents)
      .set({ processedAt: null })
      .where(eq(schema.rawEvents.id, stored.id));

    const replay = await processRawEvent(db, stored.id);
    expect(replay.status).toBe("duplicate");
    expect(await countActivities()).toBe(1);
  });

  it("stores only one raw event for a redelivered payload", async () => {
    await addContact(acmeId, "+17045551234");
    const payload = buildCallLogPayload({
      telephonySessionId: "s-032",
      counterpartyNumber: "+17045551234",
    });
    await ingest(payload);
    await ingest(payload);
    await ingest(payload);

    expect((await db.select().from(schema.rawEvents)).length).toBe(1);
  });
});

describe("a number that cannot be attributed", () => {
  it("files an unknown number for review and creates no activity", async () => {
    const { outcome } = await ingest(
      buildCallLogPayload({ telephonySessionId: "s-040", counterpartyNumber: "+17045559999" }),
    );

    expect(outcome.status).toBe("unmatched");
    if (outcome.status !== "unmatched") return;
    expect(outcome.reason).toBe("no_contact_match");
    expect(await countActivities()).toBe(0);

    const queue = await openQueue(db);
    expect(queue).toHaveLength(1);
    expect(queue[0].phoneE164).toBe("+17045559999");
  });

  it("files withheld caller ID rather than guessing", async () => {
    const { outcome } = await ingest(
      buildCallLogPayload({ telephonySessionId: "s-041", counterpartyNumber: "anonymous" }),
    );
    expect(outcome.status).toBe("unmatched");
    if (outcome.status !== "unmatched") return;
    expect(outcome.reason).toBe("unusable_phone_number");
    expect(await countActivities()).toBe(0);
  });

  it("produces one queue row per problem, not one per delivery attempt", async () => {
    const payload = buildCallLogPayload({
      telephonySessionId: "s-042",
      counterpartyNumber: "+17045559999",
    });
    await ingest(payload);
    await ingest(payload);

    expect(await openQueue(db)).toHaveLength(1);
  });
});

describe("a number at two different accounts", () => {
  // The requirement, stated exactly: one queue row, zero activities. Ambiguity
  // is never resolved by picking one.
  it("creates one review item and zero activities", async () => {
    await addContact(acmeId, "+17045551234");
    await addContact(globexId, "+17045551234");

    const { outcome } = await ingest(
      buildCallLogPayload({ telephonySessionId: "s-050", counterpartyNumber: "+17045551234" }),
    );

    expect(outcome.status).toBe("unmatched");
    if (outcome.status !== "unmatched") return;
    expect(outcome.reason).toBe("multiple_accounts");
    expect(await countActivities()).toBe(0);

    const queue = await openQueue(db);
    expect(queue).toHaveLength(1);
    expect(queue[0].candidateAccountIds).toHaveLength(2);
    expect(queue[0].candidateAccountIds).toEqual(expect.arrayContaining([acmeId, globexId]));
  });

  it("matches normally when two contacts share a number at the SAME account", async () => {
    // A shared switchboard inside one company is not ambiguous -- the account
    // is unique even though the contacts are not.
    await addContact(acmeId, "+17045551234");
    await addContact(acmeId, "+17045551234");

    const { outcome } = await ingest(
      buildCallLogPayload({ telephonySessionId: "s-051", counterpartyNumber: "+17045551234" }),
    );

    expect(outcome.status).toBe("matched");
    expect(await countActivities()).toBe(1);
  });
});

describe("resolving from the review queue", () => {
  it("creates the activity, attaches the contact, and stamps the audit trail", async () => {
    await addContact(acmeId, "+17045551234");
    await addContact(globexId, "+17045551234");

    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-060",
        counterpartyNumber: "+17045551234",
        durationSeconds: 300,
      }),
    );

    const [item] = await openQueue(db);
    const result = await resolveUnmatched(db, item.id, globexId, repId);
    expect("activityId" in result).toBe(true);

    const [activity] = await db.select().from(schema.activities);
    expect(activity.accountId).toBe(globexId);
    expect(activity.qualifies).toBe(true);
    expect(activity.qualificationReason).toContain("resolved from review queue");
    // The contact at the chosen account is attached, not the one at the other.
    expect(activity.contactId).not.toBeNull();

    const [resolved] = await db.select().from(schema.unmatchedActivities);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe(repId);
    expect(resolved.resolvedToAccountId).toBe(globexId);
    expect(resolved.resolvedActivityId).toBe(activity.id);
    expect(await openQueue(db)).toHaveLength(0);
  });

  it("refuses to resolve the same item twice", async () => {
    await ingest(
      buildCallLogPayload({ telephonySessionId: "s-061", counterpartyNumber: "+17045559999" }),
    );
    const [item] = await openQueue(db);

    await resolveUnmatched(db, item.id, acmeId, repId);
    const second = await resolveUnmatched(db, item.id, acmeId, repId);

    expect("error" in second).toBe(true);
    expect(await countActivities()).toBe(1);
  });

  it("carries qualification through: a short call resolves as non-qualifying", async () => {
    await ingest(
      buildCallLogPayload({
        telephonySessionId: "s-062",
        counterpartyNumber: "+17045559999",
        durationSeconds: 40,
      }),
    );
    const [item] = await openQueue(db);
    await resolveUnmatched(db, item.id, acmeId, repId);

    const [activity] = await db.select().from(schema.activities);
    expect(activity.qualifies).toBe(false);
    expect(activity.qualificationReason).toContain("40s");
  });
});

describe("telephony session events", () => {
  it("matches the account but reports that it cannot qualify", async () => {
    // A session event carries no duration. The honest answer is "not enough
    // information", written into the record -- not a silent pass.
    await addContact(acmeId, "+17045551234");

    const { outcome } = await ingest(
      buildTelephonySessionPayload({
        telephonySessionId: "s-070",
        counterpartyNumber: "+17045551234",
      }),
    );

    expect(outcome.status).toBe("matched");
    const [activity] = await db.select().from(schema.activities);
    expect(activity.accountId).toBe(acmeId);
    expect(activity.qualifies).toBe(false);
    expect(activity.qualificationReason).toMatch(/result|duration/i);
  });
});

describe("email follows the same path, keyed on address", () => {
  it("matches a contact by email and qualifies", async () => {
    await addContact(acmeId, null, "robin.vega@acmehome.test");

    const { outcome } = await ingest(
      buildEmailPayload({ messageId: "m-001", counterpartyEmail: "robin.vega@acmehome.test" }),
      "email",
    );

    expect(outcome.status).toBe("matched");
    const [activity] = await db.select().from(schema.activities);
    expect(activity.type).toBe("email");
    expect(activity.qualifies).toBe(true);
  });

  it("ignores case in the address", async () => {
    await addContact(acmeId, null, "robin.vega@acmehome.test");
    const { outcome } = await ingest(
      buildEmailPayload({ messageId: "m-002", counterpartyEmail: "Robin.Vega@AcmeHome.TEST" }),
      "email",
    );
    expect(outcome.status).toBe("matched");
  });

  it("queues a duplicate address found at two accounts", async () => {
    await addContact(acmeId, null, "info@shared.test");
    await addContact(globexId, null, "info@shared.test");

    const { outcome } = await ingest(
      buildEmailPayload({ messageId: "m-003", counterpartyEmail: "info@shared.test" }),
      "email",
    );

    expect(outcome.status).toBe("unmatched");
    if (outcome.status !== "unmatched") return;
    expect(outcome.reason).toBe("multiple_accounts");
    expect(await countActivities()).toBe(0);
  });
});

describe("malformed input", () => {
  it("records an unparseable payload as an error rather than throwing", async () => {
    const stored = await storeRawEvent(db, "ringcentral", "s-080", { nonsense: true });
    const outcome = await processRawEvent(db, stored.id);

    expect(outcome.status).toBe("unparseable");
    const [raw] = await db.select().from(schema.rawEvents);
    // The error is on the row, so a broken integration is visible in a query
    // instead of only in a log that has already rotated away.
    expect(raw.error).toBeTruthy();
    expect(raw.processedAt).not.toBeNull();
  });

  it("reports a missing event without throwing", async () => {
    const outcome = await processRawEvent(db, "00000000-0000-0000-0000-000000000000");
    expect(outcome.status).toBe("unparseable");
  });
});
