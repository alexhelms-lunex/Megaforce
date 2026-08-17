import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "../../db/drizzle-local";
import type { LocalDb } from "../../db/local";
import * as schema from "@/lib/db/schema";
import {
  accountState,
  availableAccounts,
  claimAccount,
  claimHistory,
  releaseAccount,
  releaseOverdueAccounts,
} from "@/lib/lifecycle";

/**
 * The ownership mechanic, tested against real Postgres.
 *
 * This is the part of the system a sales floor will argue about, so the rules
 * are pinned down here rather than trusted to a screen: who can take what, what
 * happens at each day boundary, and what the record shows afterwards.
 */

let db: LocalDrizzle;
let pg: LocalDb;
let dana: string;
let kai: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    delete from account_claims;
    delete from unmatched_activities;
    delete from activities;
    delete from raw_events;
    delete from contacts;
    delete from opportunities;
    delete from accounts;
    delete from users;

    -- Restore the shipped thresholds. One test below deliberately changes them
    -- to prove the rules are data; without this reset that change leaks into
    -- every test that runs afterwards and they fail somewhere unrelated.
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
  [{ id: kai }] = await db
    .insert(schema.users)
    .values({ email: "kai@megaforce.test", fullName: "Kai Osei", role: "broker" })
    .returning({ id: schema.users.id });
});

/** An account owned by `owner`, whose last qualifying activity was N days ago. */
async function makeAccount(opts: {
  name?: string;
  owner?: string | null;
  daysSinceActivity?: number | null;
  daysSinceClaim?: number;
  status?: string;
}) {
  const [row] = await db
    .insert(schema.accounts)
    .values({
      name: opts.name ?? "Ironwood Manufacturing",
      ownerId: opts.owner ?? null,
      status: opts.status ?? "prospect",
    })
    .returning({ id: schema.accounts.id });

  // Set the clock columns directly. The claim trigger stamps claimed_at to now
  // on insert-with-owner, which is not the history a test needs.
  await db.execute(sql`
    update accounts set
      last_activity_at = ${opts.daysSinceActivity === null || opts.daysSinceActivity === undefined
        ? null
        : sql`now() - (${opts.daysSinceActivity} || ' days')::interval`},
      claimed_at = ${opts.owner
        ? sql`now() - (${opts.daysSinceClaim ?? 90} || ' days')::interval`
        : null}
    where id = ${row.id}
  `);
  return row.id;
}

const stateOf = async (id: string) => (await accountState(db, id))!.state;

// ---------------------------------------------------------------------------

describe("what state an account is in", () => {
  it("calls an unowned account available", async () => {
    const id = await makeAccount({ owner: null });
    expect(await stateOf(id)).toBe("available");
  });

  // The thresholds for a prospect are 14 / 21 / 31 days. The last of those is
  // the one the business states directly: past thirty days, it is gone.
  it("walks through amber, red and overdue at the configured days", async () => {
    const cases: [number, string][] = [
      [1, "fresh"],
      [13, "fresh"],
      [14, "warning"],
      [20, "warning"],
      [21, "expiring"],
      [30, "expiring"],
      [31, "overdue"],
      [90, "overdue"],
    ];
    for (const [days, expected] of cases) {
      const id = await makeAccount({ owner: dana, daysSinceActivity: days });
      expect(await stateOf(id), `${days} days`).toBe(expected);
    }
  });

  it("counts from the claim date when a new owner has not worked it yet", async () => {
    // Otherwise a broker inherits an account already in the red for somebody
    // else's neglect, and loses it before they have had a chance.
    const id = await makeAccount({ owner: dana, daysSinceActivity: null, daysSinceClaim: 2 });
    expect(await stateOf(id)).toBe("fresh");
  });

  it("gives a converted customer a much longer leash than a prospect", async () => {
    // Customers are Salesforce's problem; the CRM must not yank an account
    // somebody has already won.
    const prospect = await makeAccount({ owner: dana, daysSinceActivity: 50, status: "prospect" });
    const customer = await makeAccount({ owner: dana, daysSinceActivity: 50, status: "customer" });
    expect(await stateOf(prospect)).toBe("overdue");
    expect(await stateOf(customer)).toBe("fresh");
  });

  it("obeys a threshold change made in the database, with no code change", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 16 });
    expect(await stateOf(id)).toBe("warning");

    await db.execute(
      sql`update account_retention_rules set warning_days = 5, expiring_days = 10, release_days = 14 where applies_to = 'prospect'`,
    );
    expect(await stateOf(id)).toBe("overdue");
  });

  it("reports days remaining, going negative once past the deadline", async () => {
    const soon = await makeAccount({ owner: dana, daysSinceActivity: 26 });
    const gone = await makeAccount({ owner: dana, daysSinceActivity: 50 });
    expect((await accountState(db, soon))!.daysLeft).toBe(5);
    expect((await accountState(db, gone))!.daysLeft).toBeLessThan(0);
  });
});

describe("claiming from the pool", () => {
  it("hands an unowned account to whoever asks", async () => {
    const id = await makeAccount({ owner: null });
    const result = await claimAccount(db, id, dana);

    expect(result.ok).toBe(true);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(account.ownerId).toBe(dana);
    expect(account.claimedAt).not.toBeNull();
  });

  it("lets exactly one of two simultaneous claims win", async () => {
    // The real race: two brokers click at the same moment. Protection is the
    // isNull(ownerId) in the UPDATE, not a check-then-write in application code.
    const id = await makeAccount({ owner: null });
    const [first, second] = await Promise.all([
      claimAccount(db, id, dana),
      claimAccount(db, id, kai),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const loser = [first, second].find((r) => !r.ok)!;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.reason).toBe("already_claimed");
  });

  it("names who took it, rather than just refusing", async () => {
    const id = await makeAccount({ owner: dana });
    const result = await claimAccount(db, id, kai);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("already_claimed");
      expect(result.detail).toContain("Dana Whitfield");
    }
  });

  it("says so when the account is gone entirely", async () => {
    const result = await claimAccount(db, "00000000-0000-0000-0000-000000000000", dana);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("puts a freshly claimed account straight back to fresh", async () => {
    // Claimed from the pool after sitting cold for months. The new owner starts
    // with a full clock.
    const id = await makeAccount({ owner: null, daysSinceActivity: 200 });
    await claimAccount(db, id, dana);
    expect(await stateOf(id)).toBe("fresh");
  });
});

describe("losing an account", () => {
  it("returns it to the pool and records why", async () => {
    const id = await makeAccount({ owner: dana });
    await releaseAccount(db, id, "manual");

    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(account.ownerId).toBeNull();
    expect(await stateOf(id)).toBe("available");

    const history = await claimHistory(db, id);
    expect(history[0].releasedAt).not.toBeNull();
    expect(history[0].releaseReason).toBe("manual");
    expect(history[0].userName).toBe("Dana Whitfield");
  });

  it("keeps the full history across several owners", async () => {
    // The question a territory argument turns on: who had this, and when.
    const id = await makeAccount({ owner: null });
    await claimAccount(db, id, dana);
    await releaseAccount(db, id, "manual");
    await claimAccount(db, id, kai);

    const history = await claimHistory(db, id);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.userName)).toEqual(
      expect.arrayContaining(["Dana Whitfield", "Kai Osei"]),
    );
    // The current holder's claim is still open.
    expect(history.find((h) => h.userName === "Kai Osei")!.releasedAt).toBeNull();
  });

  it("shows the account in the available pool afterwards", async () => {
    const id = await makeAccount({ owner: dana, name: "Redwood Distribution" });
    expect((await availableAccounts(db)).map((a) => a.id)).not.toContain(id);

    await releaseAccount(db, id, "manual");
    const pool = await availableAccounts(db);
    expect(pool.map((a) => a.id)).toContain(id);
    expect(pool.find((a) => a.id === id)!.state).toBe("available");
  });
});

describe("the nightly sweep", () => {
  it("takes back only the accounts that are actually overdue", async () => {
    const safe = await makeAccount({ owner: dana, daysSinceActivity: 10, name: "Safe Co" });
    const amber = await makeAccount({ owner: dana, daysSinceActivity: 16, name: "Amber Co" });
    const red = await makeAccount({ owner: dana, daysSinceActivity: 25, name: "Red Co" });
    const gone = await makeAccount({ owner: dana, daysSinceActivity: 60, name: "Gone Co" });

    const { released } = await releaseOverdueAccounts(db);

    expect(released.map((r) => r.name)).toEqual(["Gone Co"]);
    expect(await stateOf(safe)).toBe("fresh");
    expect(await stateOf(amber)).toBe("warning");
    expect(await stateOf(red)).toBe("expiring");
    expect(await stateOf(gone)).toBe("available");
  });

  it("records the reason as expired, not as a manual give-up", async () => {
    // A broker who lost an account to the clock should be able to see that is
    // what happened, rather than a record implying they handed it over.
    const id = await makeAccount({ owner: dana, daysSinceActivity: 60 });
    await releaseOverdueAccounts(db);

    const history = await claimHistory(db, id);
    expect(history[0].releaseReason).toBe("expired");
  });

  it("reports who lost each account, so the morning conversation can happen", async () => {
    await makeAccount({ owner: dana, daysSinceActivity: 60, name: "One" });
    await makeAccount({ owner: kai, daysSinceActivity: 60, name: "Two" });

    const { released } = await releaseOverdueAccounts(db);
    expect(released).toHaveLength(2);
    expect(released.map((r) => r.ownerId)).toEqual(expect.arrayContaining([dana, kai]));
  });

  it("does nothing on a second run", async () => {
    await makeAccount({ owner: dana, daysSinceActivity: 60 });
    expect((await releaseOverdueAccounts(db)).released).toHaveLength(1);
    expect((await releaseOverdueAccounts(db)).released).toHaveLength(0);
  });

  it("leaves customers alone even when long untouched", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 100, status: "customer" });
    await releaseOverdueAccounts(db);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(account.ownerId).toBe(dana);
  });
});

describe("a qualifying call resets the clock", () => {
  it("moves an expiring account back to fresh", async () => {
    // The entire point of the mechanic: work the account and you keep it. This
    // ties the call pipeline to ownership -- the trigger on activities updates
    // last_activity_at, which is what account_state reads.
    const id = await makeAccount({ owner: dana, daysSinceActivity: 25 });
    expect(await stateOf(id)).toBe("expiring");

    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 300,
      result: "Call connected",
      qualifies: true,
      qualificationReason: "qualified: result \"Call connected\", duration 300s met the 120s threshold",
    });

    expect(await stateOf(id)).toBe("fresh");
  });

  it("does not reset for a call that did not qualify", async () => {
    // A 40 second wrong number must not buy another 45 days.
    const id = await makeAccount({ owner: dana, daysSinceActivity: 25 });

    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 40,
      result: "Call connected",
      qualifies: false,
      qualificationReason: "duration 40s is below the 120s threshold",
    });

    expect(await stateOf(id)).toBe("expiring");
  });
});

/**
 * The clock resets when an account falls out of somebody's name.
 *
 * Stated by the business, and it governs more than the flag: everything derived
 * from last_activity_at -- the "Last counted" column, the quiet-for-N-days
 * filters, the never-worked preset, the dashboard counts -- has to agree with
 * it, or one screen contradicts another.
 */
describe("the clock resets when the account changes hands", () => {
  const lastActivityOf = async (id: string) => {
    const rows = await db.execute<{ last_activity_at: string | null }>(
      sql`select last_activity_at from accounts where id = ${id}`,
    );
    const list = Array.isArray(rows)
      ? rows
      : (rows as { rows: { last_activity_at: string | null }[] }).rows;
    return list[0].last_activity_at;
  };

  it("clears the clock when an account is released to the pool", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 10 });
    expect(await lastActivityOf(id)).not.toBeNull();

    await releaseAccount(db, id, "manual");

    expect(await lastActivityOf(id)).toBeNull();
  });

  it("gives the next broker a clean clock rather than the last one's neglect", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 25 });
    expect(await stateOf(id)).toBe("expiring");

    await releaseAccount(db, id, "manual");
    await claimAccount(db, id, kai);

    expect(await stateOf(id)).toBe("fresh");
    // The flag was already right, because account_state judges from the claim
    // date. This is the part that was wrong: the column the list prints, the
    // quiet-for-N-days filters and the never-worked preset all read this
    // directly, so a stale value here showed "62d ago" in red beside a green
    // flag on an account nobody had had a chance to work.
    expect(await lastActivityOf(id)).toBeNull();
  });

  it("keeps the activity history, which is evidence rather than a clock", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 10 });
    await db.insert(schema.activities).values({
      accountId: id,
      type: "call",
      occurredAt: new Date(),
      durationSeconds: 300,
      result: "Call connected",
      qualifies: true,
      qualificationReason: "qualified",
    });

    await releaseAccount(db, id, "manual");

    const rows = await db.execute<{ c: string }>(
      sql`select count(*)::text c from activities where account_id = ${id}`,
    );
    const list = Array.isArray(rows) ? rows : (rows as { rows: { c: string }[] }).rows;
    // Whoever picks this company up next needs to read what was already said to
    // them. Only the pointer the clock reads is reset.
    expect(Number(list[0].c)).toBe(1);
  });

  it("clears the clock on a straight reassignment too, not only a release", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 40 });

    // An admin moving it directly, without it passing through the pool. It has
    // still fallen out of Dana's name.
    await db.execute(sql`update accounts set owner_id = ${kai} where id = ${id}`);

    expect(await lastActivityOf(id)).toBeNull();
    expect(await stateOf(id)).toBe("fresh");
  });

  it("does not carry an amnesty across to the next holder", async () => {
    const id = await makeAccount({ owner: dana, daysSinceActivity: 40 });
    await db.execute(sql`
      update accounts set retention_override_until = now() + interval '60 days' where id = ${id}
    `);
    expect(await stateOf(id)).toBe("protected");

    await releaseAccount(db, id, "manual");
    await claimAccount(db, id, kai);

    // The extension was granted to Dana for Dana's reasons. Kai gets the
    // ordinary clock, not sixty free days somebody else argued for.
    expect(await stateOf(id)).toBe("fresh");
    const rows = await db.execute<{ retention_override_until: string | null }>(
      sql`select retention_override_until from accounts where id = ${id}`,
    );
    const list = Array.isArray(rows)
      ? rows
      : (rows as { rows: { retention_override_until: string | null }[] }).rows;
    expect(list[0].retention_override_until).toBeNull();
  });
});
