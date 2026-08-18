import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "../../db/drizzle-local";
import type { LocalDb } from "../../db/local";
import * as schema from "@/lib/db/schema";
import { storeRawEvent, extractExternalId } from "@/lib/ingest";
import { processRawEvent } from "@/lib/matcher";
import { sweepRawEvents } from "@/lib/sweep";
import { buildCallLogPayload } from "@/lib/ringcentral/payloads";

/**
 * The safety net under the webhook.
 *
 * ===========================================================================
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * The webhook writes a call down, answers RingCentral, and works out which
 * company it belongs to afterwards. If the process dies in between, the call is
 * on disk and nothing will ever look at it again. Alex chose to build the
 * recovery rather than pay a queue service for it, which means the recovery has
 * to actually work -- and its failure mode is the same as the bug it fixes:
 * total silence. A sweep that quietly does nothing looks exactly like a sweep
 * with nothing to do.
 *
 * So every test here creates the situation by hand -- a stored event that never
 * got processed -- and proves the sweep finds it, files it, and does not file
 * it twice.
 *
 * Run against real Postgres in-process. The idempotency this depends on is
 * enforced by partial unique indexes, and a mocked database would accept every
 * duplicate write those indexes exist to reject.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;
let repId: string;
let accountId: string;

const BUYER_PHONE = "+17045550142";

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from accounts;
    delete from users;
  `);

  const [rep] = await db
    .insert(schema.users)
    .values({
      email: "dana@megaforce.test",
      fullName: "Dana",
      role: "broker",
      rcExtensionId: "101",
    })
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
    phoneE164: BUYER_PHONE,
  });
});

/**
 * A call that arrived and was never filed.
 *
 * `receivedAgoMinutes` backdates the row, because the sweep deliberately
 * ignores anything recent -- an event from ten seconds ago is probably being
 * processed right now by the request that received it.
 */
async function storeUnprocessed(
  sessionId: string,
  receivedAgoMinutes = 30,
  phone = BUYER_PHONE,
): Promise<string> {
  const payload = buildCallLogPayload({
    telephonySessionId: sessionId,
    counterpartyNumber: phone,
    durationSeconds: 240,
    extensionId: "101",
  });
  const { id } = await storeRawEvent(
    db,
    "ringcentral",
    extractExternalId(payload, "ringcentral"),
    payload,
  );
  await db.execute(
    sql.raw(
      `update raw_events set received_at = now() - interval '${receivedAgoMinutes} minutes' where id = '${id}'`,
    ),
  );
  return id;
}

async function activityCount(): Promise<number> {
  const rows = await pg.query<{ n: number }>("select count(*)::int as n from activities");
  return rows.rows[0].n;
}

// ===========================================================================
describe("finding what was left behind", () => {
  it("files a call that was stored and never processed", async () => {
    await storeUnprocessed("call-1");
    expect(await activityCount()).toBe(0);

    const result = await sweepRawEvents(db);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(await activityCount()).toBe(1);
  });

  it("credits it to the right rep and the right account", async () => {
    // Not just "an activity exists" -- a sweep that files calls against the
    // wrong company is worse than one that files nothing.
    await storeUnprocessed("call-2");
    await sweepRawEvents(db);

    const rows = await pg.query<{
      account_id: string;
      user_id: string;
      qualifies: boolean;
      qualification_reason: string;
    }>("select account_id, user_id, qualifies, qualification_reason from activities");

    expect(rows.rows[0].account_id).toBe(accountId);
    // Credited to the extension that made the call, not to whoever holds the
    // account. Those are the same person here; they very often are not.
    expect(rows.rows[0].user_id).toBe(repId);

    // NOT qualified, and that is correct: a call log arrives from the phone
    // system with no write-up on it, and the prospecting policy requires notes
    // and a stage before anything holds an account's clock. Asserting the
    // reason rather than just the flag, because "did not count" with an empty
    // explanation is the complaint this whole column exists to answer.
    expect(rows.rows[0].qualifies).toBe(false);
    expect(rows.rows[0].qualification_reason).toBeTruthy();
  });

  it("marks the event processed, so the next sweep skips it", async () => {
    await storeUnprocessed("call-3");
    await sweepRawEvents(db);

    const second = await sweepRawEvents(db);
    expect(second.processed).toBe(0);
    expect(await activityCount()).toBe(1);
  });

  it("does not double-file an event that was already processed normally", async () => {
    // The ordinary case: the webhook filed it, and the sweep runs anyway.
    const id = await storeUnprocessed("call-4");
    await processRawEvent(db, id);
    expect(await activityCount()).toBe(1);

    const result = await sweepRawEvents(db);
    expect(result.processed).toBe(0);
    expect(await activityCount()).toBe(1);
  });

  it("sends a call with no matching contact to the review queue rather than dropping it", async () => {
    await storeUnprocessed("call-5", 30, "+19995550000");
    const result = await sweepRawEvents(db);

    expect(result.processed).toBe(1);
    const queue = await pg.query<{ n: number }>(
      "select count(*)::int as n from unmatched_activities where resolved_at is null",
    );
    expect(queue.rows[0].n).toBe(1);
  });
});

// ===========================================================================
describe("what it deliberately leaves alone", () => {
  it("ignores an event that arrived moments ago", async () => {
    // Very likely still being processed right now by the request that received
    // it. Sweeping it is safe but wasteful, and it fills the log with races.
    await storeUnprocessed("call-6", 0);
    const result = await sweepRawEvents(db);
    expect(result.processed).toBe(0);
    expect(await activityCount()).toBe(0);
  });

  it("picks that same event up once it is old enough", async () => {
    await storeUnprocessed("call-7", 0);
    expect((await sweepRawEvents(db)).processed).toBe(0);
    expect((await sweepRawEvents(db, { olderThanMinutes: 0 })).processed).toBe(1);
  });

  it("never retries an event that has already been recorded as unreadable", async () => {
    // Otherwise one malformed payload is retried on every sweep forever, and
    // the log fills with the same failure until somebody notices.
    const id = await storeUnprocessed("call-8");
    await db.execute(sql`update raw_events set error = 'unreadable' where id = ${id}`);

    const result = await sweepRawEvents(db);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ===========================================================================
describe("a backlog", () => {
  it("takes a bounded batch and reports how many are left", async () => {
    // The moment this matters is also the moment it is dangerous: clearing
    // thousands in one cron run hits the timeout and clears none.
    for (let i = 0; i < 7; i++) await storeUnprocessed(`bulk-${i}`);

    const first = await sweepRawEvents(db, { limit: 3 });
    expect(first.processed).toBe(3);
    expect(first.remaining).toBe(4);

    const second = await sweepRawEvents(db, { limit: 3 });
    expect(second.processed).toBe(3);
    expect(second.remaining).toBe(1);

    const third = await sweepRawEvents(db, { limit: 3 });
    expect(third.processed).toBe(1);
    expect(third.remaining).toBe(0);

    expect(await activityCount()).toBe(7);
  });

  it("takes the oldest first, so nothing starves at the back of the queue", async () => {
    await storeUnprocessed("older", 120);
    await storeUnprocessed("newer", 10);

    await sweepRawEvents(db, { limit: 1 });
    const rows = await pg.query<{ external_id: string }>(
      "select external_id from raw_events where processed_at is not null",
    );
    expect(rows.rows[0].external_id).toContain("older");
  });

  it("reports nothing to do without touching anything", async () => {
    const result = await sweepRawEvents(db);
    expect(result).toEqual({ processed: 0, failed: 0, remaining: 0 });
  });
});
