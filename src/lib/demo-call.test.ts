import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "../../db/drizzle-local";
import type { LocalDb } from "../../db/local";
import * as schema from "@/lib/db/schema";

/**
 * A call, with no phone system anywhere.
 *
 * ===========================================================================
 * This is the thing being demonstrated to a room, so "it looked like it worked"
 * is not good enough. Each test asserts the row that actually landed.
 *
 * The middle case is the one the whole design turns on: a call the phone system
 * saw, which does NOT count until a person writes it up. If that ever silently
 * started counting on arrival, the control Alex wants -- brokers cannot hold an
 * account without doing the work -- would be gone, and nothing on any screen
 * would look different.
 *
 * db is pointed at PGlite for the duration. lib/demo-call imports the global
 * connection, so the module has to be loaded AFTER the mock is in place.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;

vi.mock("@/lib/db", () => ({
  get db() {
    return db;
  },
}));

let simulateCall: typeof import("@/lib/demo-call").simulateCall;
let clearSimulatedCalls: typeof import("@/lib/demo-call").clearSimulatedCalls;

let repId: string;
let accountId: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
  ({ simulateCall, clearSimulatedCalls } = await import("@/lib/demo-call"));
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

async function activities() {
  const { rows } = await pg.query<{
    account_id: string;
    user_id: string;
    duration_seconds: number;
    qualifies: boolean;
    qualification_reason: string;
    source: string;
    external_id: string;
  }>(
    `select account_id, user_id, duration_seconds, qualifies, qualification_reason,
            source, external_id from activities`,
  );
  return rows;
}

// ===========================================================================
describe("a conversation that should count once it is written up", () => {
  it("lands on the right account, credited to the right rep", async () => {
    const result = await simulateCall("connected", repId, 1_000);
    expect(result.ok).toBe(true);

    const rows = await activities();
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(accountId);
    expect(rows[0].user_id).toBe(repId);
    expect(rows[0].duration_seconds).toBe(214);
  });

  it("does NOT count on arrival, and says why", async () => {
    // The control. A call arriving from the phone system is evidence that it
    // happened; it is not evidence that anybody did anything useful. If this
    // ever flips to true on arrival, a broker keeps an account by dialling and
    // hanging up, and no screen would show anything different.
    await simulateCall("connected", repId, 2_000);
    const [row] = await activities();
    expect(row.qualifies).toBe(false);
    expect(row.qualification_reason).toMatch(/not yet logged/i);
  });

  it("goes through the real front door, so it is a real call record", async () => {
    await simulateCall("connected", repId, 3_000);
    const [row] = await activities();
    // Same source a live RingCentral call carries -- this is the pipeline being
    // fed by hand, not a second pipeline that behaves similarly.
    expect(row.source).toBe("ringcentral");
    expect(row.external_id).toContain("sim-");
  });

  it("produces a second call when pressed twice rather than silently deduplicating", async () => {
    await simulateCall("connected", repId, 4_000);
    await simulateCall("connected", repId, 5_000);
    expect(await activities()).toHaveLength(2);
  });
});

describe("a call too short to count", () => {
  it("arrives, and can never qualify however it is written up", async () => {
    await simulateCall("brief", repId, 6_000);
    const [row] = await activities();
    expect(row.duration_seconds).toBe(25);
    expect(row.qualifies).toBe(false);
  });
});

describe("a number nobody has on file", () => {
  it("goes to the review queue instead of being dropped", async () => {
    const result = await simulateCall("unknown", repId, 7_000);
    expect(result.ok).toBe(true);
    expect(result.href).toBe("/review");

    expect(await activities()).toHaveLength(0);
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from unmatched_activities where resolved_at is null",
    );
    expect(rows[0].n).toBe(1);
  });

  it("uses a number reserved for fiction, so nobody real is ever called back", async () => {
    await simulateCall("unknown", repId, 8_000);
    const { rows } = await pg.query<{ phone_e164: string }>(
      "select phone_e164 from unmatched_activities",
    );
    expect(rows[0].phone_e164).toBe("+15555550137");
  });
});

describe("clearing up afterwards", () => {
  it("removes every simulated call and leaves real ones alone", async () => {
    // Demo data still sitting in a database somebody later uses for real is a
    // problem that surfaces months later disguised as a reporting bug.
    await simulateCall("connected", repId, 9_000);
    await simulateCall("unknown", repId, 10_000);

    const real = await db
      .insert(schema.rawEvents)
      .values({ source: "ringcentral", externalId: "genuine-call-1", payload: {} })
      .returning({ id: schema.rawEvents.id });

    const removed = await clearSimulatedCalls();
    expect(removed).toBe(2);

    expect(await activities()).toHaveLength(0);
    const { rows: queue } = await pg.query<{ n: number }>(
      "select count(*)::int as n from unmatched_activities",
    );
    expect(queue[0].n).toBe(0);

    const { rows: kept } = await pg.query<{ id: string }>(
      `select id from raw_events where external_id = 'genuine-call-1'`,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(real[0].id);
  });

  it("says so plainly when there is nothing to remove", async () => {
    expect(await clearSimulatedCalls()).toBe(0);
  });
});

describe("when there is nobody to have called", () => {
  it("explains that rather than inventing a contact", async () => {
    await pg.exec("delete from contacts;");
    const result = await simulateCall("connected", repId, 11_000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no contacts with a phone number/i);
  });

  it("can still show the review queue, which needs nobody on file", async () => {
    await pg.exec("delete from contacts;");
    const result = await simulateCall("unknown", repId, 12_000);
    expect(result.ok).toBe(true);
  });
});
