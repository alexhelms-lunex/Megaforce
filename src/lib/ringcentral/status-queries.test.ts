import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "../../../db/drizzle-local";
import type { LocalDb } from "../../../db/local";
import * as schema from "@/lib/db/schema";

/**
 * The Phone connection screen's queries, actually executed.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 *
 * The screen shipped with `) both` as a subquery alias. BOTH is a reserved word
 * in Postgres -- it belongs to TRIM(BOTH ...) -- so the query was a syntax
 * error every single time it ran, and it reached a person before it reached a
 * test.
 *
 * It could not have been caught. pipelineState() is only reachable through
 * ringCentralStatus(), and the page test mocks that function wholesale, for
 * good reasons: it talks to RingCentral over HTTP and to Postgres over a
 * socket, and neither exists in a unit test. So the SQL had no execution path
 * anywhere except production.
 *
 * That is the actual defect. A query nothing runs is a query nobody has
 * checked, however carefully it was read -- and reading is exactly what does
 * not catch a reserved word, because `both` reads perfectly.
 *
 * So: real Postgres, real schema, real query. RingCentral is left unconfigured,
 * which makes the network half return "not configured" without reaching for a
 * socket, leaving the database half to be exercised on its own.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    get db() {
      return db;
    },
    tryGetDb: () => db,
  };
});

let ringCentralStatus: typeof import("@/lib/ringcentral/status").ringCentralStatus;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
  // Left unset so subscriptionState() reports "not configured" instead of
  // opening a connection to RingCentral.
  delete process.env.RC_CLIENT_ID;
  delete process.env.RC_CLIENT_SECRET;
  delete process.env.RC_JWT;
  ({ ringCentralStatus } = await import("@/lib/ringcentral/status"));
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
});

// ===========================================================================
describe("reading the pipeline's state", () => {
  it("runs every query without a syntax error", async () => {
    // The whole point. `databaseError` is null only if all of them parsed AND
    // executed -- which is the check that was missing when `) both` shipped.
    const status = await ringCentralStatus();

    expect(status.databaseError).toBeNull();
    expect(status.databaseReachable).toBe(true);
  });

  it("finds no schema gaps against a fully migrated database", async () => {
    // Doubles as a guard on the gap list itself: an entry naming a column that
    // does not exist in the migrations would report a healthy database as
    // broken, on the one screen somebody opens when they already suspect
    // something is wrong.
    const status = await ringCentralStatus();
    expect(status.schemaGaps).toEqual([]);
  });

  it("reports nothing arrived when nothing has", async () => {
    const status = await ringCentralStatus();
    expect(status.pipeline.recent).toEqual([]);
    expect(status.pipeline.callsLast7Days).toBe(0);
    expect(status.pipeline.lastCallAt).toBeNull();
  });
});

// ===========================================================================
describe("the list of calls that arrived", () => {
  it("shows a filed call and who it was credited to", async () => {
    /*
     * The column this screen exists for.
     *
     * The dock only shows a person their OWN calls, so a call credited to the
     * wrong person is invisible on every other screen -- and "nothing arrived"
     * and "everything arrived and went to somebody else" look identical
     * everywhere else in the application.
     */
    const [rep] = await db
      .insert(schema.users)
      .values({ email: "dana@megaforce.test", fullName: "Dana", role: "broker", rcExtensionId: "101" })
      .returning({ id: schema.users.id });

    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Tanglewood Milling", status: "prospect", ownerId: rep.id })
      .returning({ id: schema.accounts.id });

    await db.insert(schema.activities).values({
      accountId: account.id,
      userId: rep.id,
      type: "call",
      direction: "outbound",
      occurredAt: new Date(),
      durationSeconds: 214,
      result: "Call connected",
      source: "ringcentral",
      externalId: "s-1",
      extensionId: "101",
    });

    const status = await ringCentralStatus();

    expect(status.pipeline.recent).toHaveLength(1);
    expect(status.pipeline.recent[0]).toMatchObject({
      landed: "filed",
      company: "Tanglewood Milling",
      creditedTo: "Dana",
      extension: "101",
      durationSeconds: 214,
    });
  });

  it("shows a queued call beside it, in one list", async () => {
    // Two sources, one list, sorted together -- the union that the reserved
    // word broke. A call that went to the review queue and one that was filed
    // must appear in the same place, newest first, because "the call I made ten
    // minutes ago" is what somebody is looking for and they do not know yet
    // which road it took.
    const [raw] = await db
      .insert(schema.rawEvents)
      .values({ source: "ringcentral", externalId: "s-2", payload: {} })
      .returning({ id: schema.rawEvents.id });

    await db.insert(schema.unmatchedActivities).values({
      rawEventId: raw.id,
      reason: "no_contact_match",
      phoneE164: "+15555550137",
      direction: "outbound",
      durationSeconds: 41,
      occurredAt: new Date(),
      extensionId: "907",
    });

    const status = await ringCentralStatus();

    expect(status.pipeline.recent).toHaveLength(1);
    expect(status.pipeline.recent[0]).toMatchObject({
      landed: "queued",
      company: null,
      creditedTo: null,
      extension: "907",
    });
  });
});
