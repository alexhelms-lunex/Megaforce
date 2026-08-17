import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "./drizzle-local";
import type { LocalDb } from "./local";
import * as schema from "../src/lib/db/schema";

/**
 * "Are we fully sure this clock will always tick and never fail?"
 *
 * It was not. This file is the answer to that question, and each test is named
 * after the way it used to break. They all share one property that made them
 * dangerous: nothing on any screen looked wrong. The flags were the right
 * colours and the countdowns counted down; the rule underneath had simply
 * stopped being enforced.
 */

let db: LocalDrizzle;
let pg: LocalDb;
let dana: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    delete from job_runs;
    delete from account_requests;
    delete from account_claims;
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from opportunities;
    delete from accounts;
    delete from users;

    delete from account_retention_rules;
    insert into account_retention_rules (applies_to, warning_days, expiring_days, release_days) values
      ('prospect', 14, 21, 31),
      ('engaged',  14, 21, 31),
      ('customer', 90, 150, 181);
  `);
  [{ id: dana }] = await db
    .insert(schema.users)
    .values({ email: "dana@megaforce.test", fullName: "Dana Whitfield", role: "broker" })
    .returning({ id: schema.users.id });
});

const rows = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);

async function makeAccount(daysSinceActivity: number, owner: string | null = dana) {
  const [row] = await db
    .insert(schema.accounts)
    .values({ name: "Ironwood Manufacturing", ownerId: owner, status: "prospect" })
    .returning({ id: schema.accounts.id });
  await db.execute(sql`
    update accounts set
      last_activity_at = now() - (${daysSinceActivity} || ' days')::interval,
      claimed_at = now() - (${daysSinceActivity + 10} || ' days')::interval
    where id = ${row.id}
  `);
  return row.id;
}

const lastActivity = async (id: string) =>
  rows<{ last_activity_at: string | null }>(
    await db.execute(sql`select last_activity_at from accounts where id = ${id}`),
  )[0].last_activity_at;

const health = async () =>
  rows<{ check_name: string; ok: boolean; detail: string }>(
    await db.execute(sql`select * from clock_health()`),
  );

// ---------------------------------------------------------------------------

describe("failure 1: nothing was ever released", () => {
  it("still releases when the sweep is called", async () => {
    const id = await makeAccount(60);
    await db.execute(sql`select release_overdue_accounts()`);
    const owner = rows<{ owner_id: string | null }>(
      await db.execute(sql`select owner_id from accounts where id = ${id}`),
    )[0].owner_id;
    expect(owner).toBeNull();
  });

  it("reports a stopped sweep, because a silent one is undetectable", async () => {
    // The function was written and tested and never scheduled. Unit tests
    // passed the whole time. The only defence against that recurring is a check
    // that notices accounts piling up past their deadline.
    await makeAccount(90);
    const stopped = (await health()).find((h) => h.check_name === "nightly release")!;
    expect(stopped.ok).toBe(false);
    expect(stopped.detail).toMatch(/not running/i);

    await db.execute(sql`select release_overdue_accounts()`);
    const running = (await health()).find((h) => h.check_name === "nightly release")!;
    expect(running.ok).toBe(true);
  });
});

describe("failure 2: a future-dated activity froze the clock", () => {
  it("refuses to credit an account for work dated in the future", async () => {
    const id = await makeAccount(40);

    // A telephony webhook with a skewed clock, or a bad import. Taken at face
    // value this set last_activity_at to next year and the account could never
    // expire again -- with every screen looking completely normal.
    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(Date.now() + 365 * 86_400_000),
      durationSeconds: 300,
      result: "Call connected",
      qualifies: true,
      qualificationReason: "qualified",
    });

    const stamped = new Date(String(await lastActivity(id))).getTime();
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("still lets a genuinely recent call reset the clock", async () => {
    const id = await makeAccount(40);
    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 300,
      result: "Call connected",
      qualifies: true,
      qualificationReason: "qualified",
    });
    const state = rows<{ s: string }>(
      await db.execute(sql`
        select account_state(owner_id, status, last_activity_at, claimed_at, retention_override_until) s
          from accounts where id = ${id}
      `),
    )[0].s;
    expect(state).toBe("fresh");
  });

  it("reports any account already holding a future date", async () => {
    const id = await makeAccount(10);
    await db.execute(
      sql`update accounts set last_activity_at = now() + interval '30 days' where id = ${id}`,
    );
    const check = (await health()).find((h) => h.check_name === "future-dated activity")!;
    expect(check.ok).toBe(false);
  });
});

describe("failure 3: the rules could go missing", () => {
  it("refuses two active rules for the same status", async () => {
    // With two, account_state()'s `limit 1` picked between them arbitrarily, so
    // an account could change colour between two page loads with nothing having
    // happened to it.
    await expect(
      db.execute(sql`
        insert into account_retention_rules (applies_to, warning_days, expiring_days, release_days)
        values ('prospect', 5, 10, 15)
      `),
    ).rejects.toThrow();
  });

  it("reports a missing rule instead of quietly calling everything healthy", async () => {
    // account_state() falls back to prospect, and with that gone returns
    // 'fresh' for the entire book, forever.
    await db.execute(sql`update account_retention_rules set active = false where applies_to = 'engaged'`);
    const check = (await health()).find((h) => h.check_name === "retention rules")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/found 2/);
  });
});

describe("failure 4: moving an activity left the clock behind", () => {
  it("moves the clock to the account an activity is corrected onto", async () => {
    const wrong = await makeAccount(5);
    const right = await makeAccount(40);
    expect(await lastActivity(right)).not.toBeNull();

    const [activity] = await db
      .insert(schema.activities)
      .values({
        accountId: wrong,
        type: "call",
        occurredAt: new Date(),
        durationSeconds: 300,
        result: "Call connected",
        qualifies: true,
        qualificationReason: "qualified",
      })
      .returning({ id: schema.activities.id });

    // Fixing a mis-match: the call belonged to the other company all along.
    // qualifies never changes, so the old trigger never fired and the correct
    // account's clock stayed where it was.
    await db.execute(
      sql`update activities set account_id = ${right} where id = ${activity.id}`,
    );

    const state = rows<{ s: string }>(
      await db.execute(sql`
        select account_state(owner_id, status, last_activity_at, claimed_at, retention_override_until) s
          from accounts where id = ${right}
      `),
    )[0].s;
    expect(state).toBe("fresh");
  });
});

describe("failure 5: a call nobody owns is invisible", () => {
  it("reports unlogged calls with no owner", async () => {
    // Not lost -- invisible. It appears in no dock, so it can never be written
    // up, so it can never count, and the account it belongs to runs down its
    // clock while the work has actually been done.
    const id = await makeAccount(5);
    await db.insert(schema.activities).values({
      accountId: id,
      userId: null,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 200,
      result: "Call connected",
      qualifies: false,
      qualificationReason: "not yet logged",
    });

    const check = (await health()).find((h) => h.check_name === "unassignable calls")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/review queue/i);
  });
});

describe("the tenure counter", () => {
  const tenureOf = async (id: string) =>
    Number(
      rows<{ n: string }>(
        await db.execute(
          sql`select account_tenure_activities(id, claimed_at)::text n from accounts where id = ${id}`,
        ),
      )[0].n,
    );

  it("starts at zero and counts up as the holder works it", async () => {
    const id = await makeAccount(0);
    await db.execute(sql`update accounts set last_activity_at = null where id = ${id}`);
    expect(await tenureOf(id)).toBe(0);

    for (let i = 0; i < 3; i++) {
      await db.insert(schema.activities).values({
        accountId: id,
        type: "call",
        occurredAt: new Date(),
        durationSeconds: 300,
        result: "Call connected",
        qualifies: true,
        qualificationReason: "qualified",
      });
    }
    expect(await tenureOf(id)).toBe(3);
  });

  it("does not count work that did not qualify", async () => {
    const id = await makeAccount(0);
    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 20,
      result: "Voicemail",
      qualifies: false,
      qualificationReason: "below the threshold",
    });
    expect(await tenureOf(id)).toBe(0);
  });

  it("resets to zero when the account falls out of somebody's name", async () => {
    const id = await makeAccount(0);
    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 300,
      result: "Call connected",
      qualifies: true,
      qualificationReason: "qualified",
    });
    expect(await tenureOf(id)).toBe(1);

    await db.execute(sql`update accounts set owner_id = null where id = ${id}`);
    expect(await tenureOf(id)).toBe(0);

    // A new holder -- or the same one later -- starts a fresh count, with the
    // earlier call still on the record but no longer on the counter.
    await db.execute(sql`update accounts set owner_id = ${dana} where id = ${id}`);
    expect(await tenureOf(id)).toBe(0);
  });
});

describe("the ownership timeline", () => {
  const timeline = async (id: string) =>
    rows<{
      segment: string;
      user_name: string | null;
      days_held: string;
      release_reason: string | null;
      qualifying_activities: string;
    }>(await db.execute(sql`select * from account_ownership_timeline(${id})`));

  it("shows the unclaimed stretches as segments in their own right", async () => {
    const [{ id }] = await db
      .insert(schema.accounts)
      .values({ name: "Halvorsen Foods", ownerId: null, status: "prospect" })
      .returning({ id: schema.accounts.id });

    // Created 100 days ago, picked up at day 80, dropped at day 40, still open.
    await db.execute(sql`
      update accounts set created_at = now() - interval '100 days' where id = ${id}
    `);
    await db.execute(sql`
      insert into account_claims (account_id, user_id, claimed_at, released_at, release_reason)
      values (${id}, ${dana}, now() - interval '80 days', now() - interval '40 days', 'expired')
    `);

    const segments = await timeline(id);

    // available (100->80), owned (80->40), available (40->now)
    expect(segments.map((s) => s.segment)).toEqual(["available", "owned", "available"]);
    expect(segments[1].user_name).toBe("Dana Whitfield");
    expect(segments[1].release_reason).toBe("expired");
    expect(Number(segments[0].days_held)).toBeCloseTo(20, 0);
    expect(Number(segments[1].days_held)).toBeCloseTo(40, 0);
    expect(Number(segments[2].days_held)).toBeCloseTo(40, 0);
  });

  it("counts each holder's own qualifying work inside their own window", async () => {
    const [{ id }] = await db
      .insert(schema.accounts)
      .values({ name: "Halvorsen Foods", ownerId: null, status: "prospect" })
      .returning({ id: schema.accounts.id });
    await db.execute(sql`update accounts set created_at = now() - interval '100 days' where id = ${id}`);
    await db.execute(sql`
      insert into account_claims (account_id, user_id, claimed_at, released_at, release_reason)
      values (${id}, ${dana}, now() - interval '80 days', now() - interval '40 days', 'expired')
    `);

    // One inside Dana's window, one after it. Only the first is theirs.
    for (const days of [60, 10]) {
      await db.insert(schema.activities).values({
        accountId: id,
        type: "call",
        occurredAt: new Date(Date.now() - days * 86_400_000),
        durationSeconds: 300,
        result: "Call connected",
        qualifies: true,
        qualificationReason: "qualified",
      });
    }

    const owned = (await timeline(id)).find((s) => s.segment === "owned")!;
    expect(Number(owned.qualifying_activities)).toBe(1);
  });

  it("leaves the current holder's segment open-ended", async () => {
    const id = await makeAccount(5);
    const segments = await timeline(id);
    const current = segments[segments.length - 1];
    expect(current.segment).toBe("owned");
    expect(current.user_name).toBe("Dana Whitfield");
    expect(current.release_reason).toBeNull();
  });
});


/**
 * The thresholds hold themselves in place.
 *
 * 0017 corrected them with a one-time UPDATE, and a one-time UPDATE has one
 * failure mode and it is total: a database whose deployment predates the
 * migration keeps the old numbers forever, and nothing notices. From the
 * outside that is indistinguishable from a broken release -- 69 days against a
 * 45-day rule genuinely IS "24 days over", so the screen is telling the truth
 * about the wrong rule.
 */
describe("a stale database corrects itself", () => {
  const thresholds = async () =>
    rows<{ applies_to: string; release_days: number }>(
      await db.execute(
        sql`select applies_to, release_days from account_retention_rules where active order by applies_to`,
      ),
    );

  it("puts a drifted threshold back to the policy", async () => {
    await db.execute(
      sql`update account_retention_rules set release_days = 45 where applies_to = 'prospect'`,
    );

    const corrected = rows<{ n: number }>(
      await db.execute(sql`select ensure_policy_thresholds() n`),
    )[0].n;

    expect(corrected).toBe(1);
    expect((await thresholds()).find((t) => t.applies_to === "prospect")!.release_days).toBe(31);
  });

  it("restores a rule that has been deleted entirely", async () => {
    // Without the prospect rule, account_state() falls through and reports the
    // entire book healthy forever.
    await db.execute(sql`delete from account_retention_rules where applies_to = 'prospect'`);

    await db.execute(sql`select ensure_policy_thresholds()`);

    expect((await thresholds()).find((t) => t.applies_to === "prospect")!.release_days).toBe(31);
  });

  it("does nothing, and says so, when the numbers are already right", async () => {
    const corrected = rows<{ n: number }>(
      await db.execute(sql`select ensure_policy_thresholds() n`),
    )[0].n;
    expect(corrected).toBe(0);
  });

  it("corrects the thresholds and releases in the same sweep", async () => {
    // The order matters. Correcting after the sweep would leave a whole cycle
    // of accounts sitting overdue under the old numbers -- which is the exact
    // complaint this exists to answer.
    await db.execute(sql`
      update account_retention_rules
         set warning_days = 60, expiring_days = 75, release_days = 90
       where applies_to = 'prospect'
    `);
    const id = await makeAccount(40);

    // Under the wrong rule it is comfortably inside its window.
    expect(
      rows<{ s: string }>(
        await db.execute(sql`
          select account_state(owner_id, status, last_activity_at, claimed_at,
                               retention_override_until) s from accounts where id = ${id}
        `),
      )[0].s,
    ).toBe("fresh");

    await db.execute(sql`select * from sweep_if_due(0)`);

    const owner = rows<{ owner_id: string | null }>(
      await db.execute(sql`select owner_id from accounts where id = ${id}`),
    )[0].owner_id;
    expect(owner, "40 days is past the real 31-day rule, so it should be gone").toBeNull();
  });

  it("records what it corrected, so a hand edit being reverted is explainable", async () => {
    // Valid but wrong: the ordering constraint refuses release_days = 60 next
    // to expiring_days = 150, and rightly so. Drift has to stay well-formed to
    // be interesting -- a malformed set is caught by the CHECK already.
    await db.execute(sql`
      update account_retention_rules
         set warning_days = 30, expiring_days = 60, release_days = 120
       where applies_to = 'customer'
    `);
    await db.execute(sql`select * from sweep_if_due(0)`);

    const run = rows<{ result: { thresholds_corrected?: number } }>(
      await db.execute(sql`
        select result from job_runs where job = 'release-overdue-accounts'
         order by started_at desc limit 1
      `),
    )[0];
    expect(run.result.thresholds_corrected).toBe(1);
  });

  it("holds off when a sweep ran recently, so paging the book costs nothing", async () => {
    await db.execute(sql`select * from sweep_if_due(0)`);
    const second = rows<{ ran: boolean }>(await db.execute(sql`select * from sweep_if_due(15)`))[0];
    expect(second.ran).toBe(false);
  });
});
