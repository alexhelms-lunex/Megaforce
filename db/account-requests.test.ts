import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "./drizzle-local";
import { becomeService, becomeUser, type LocalDb } from "./local";
import * as schema from "../src/lib/db/schema";

/**
 * Account requests: amnesty, extensions, and the clock override they grant.
 *
 * This is the escape hatch from the rule that takes accounts away from people,
 * so it is exactly the mechanism somebody will try to lean on in an argument.
 * The behaviour is pinned here rather than trusted to a screen: what an
 * approval actually changes, what it deliberately does not change, and who is
 * allowed to grant one.
 */

let db: LocalDrizzle;
let pg: LocalDb;
let dana: string;
let kai: string;
let manager: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
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

  [{ id: manager }] = await db
    .insert(schema.users)
    .values({ email: "morgan@megaforce.test", fullName: "Morgan Reyes", role: "manager" })
    .returning({ id: schema.users.id });
  [{ id: dana }] = await db
    .insert(schema.users)
    .values({
      email: "dana@megaforce.test",
      fullName: "Dana Whitfield",
      role: "broker",
      managerId: manager,
    })
    .returning({ id: schema.users.id });
  [{ id: kai }] = await db
    .insert(schema.users)
    .values({
      email: "kai@megaforce.test",
      fullName: "Kai Osei",
      role: "broker",
      managerId: manager,
    })
    .returning({ id: schema.users.id });
});

/** An owned prospect whose last qualifying activity was N days ago. */
async function makeAccount(owner: string, daysSinceActivity: number, status = "prospect") {
  const [row] = await db
    .insert(schema.accounts)
    .values({ name: "Ironwood Manufacturing", ownerId: owner, status })
    .returning({ id: schema.accounts.id });
  await db.execute(sql`
    update accounts set
      last_activity_at = now() - (${daysSinceActivity} || ' days')::interval,
      claimed_at = now() - (${daysSinceActivity + 10} || ' days')::interval
    where id = ${row.id}
  `);
  return row.id;
}

async function stateOf(id: string): Promise<{ state: string; daysLeft: number | null }> {
  const rows = await db.execute<{ state: string; days_left: number | null }>(sql`
    select
      account_state(owner_id, status, last_activity_at, claimed_at, retention_override_until) as state,
      account_days_left(owner_id, status, last_activity_at, claimed_at, retention_override_until) as days_left
    from accounts where id = ${id}
  `);
  const list = Array.isArray(rows) ? rows : (rows as { rows: { state: string; days_left: number | null }[] }).rows;
  return { state: list[0].state, daysLeft: list[0].days_left };
}

async function raise(
  accountId: string,
  by: string,
  kind: string,
  extra: { days?: number; transferTo?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.accountRequests)
    .values({
      accountId,
      requestedBy: by,
      kind,
      reason: "Buyer is out until the end of the month.",
      days: extra.days ?? null,
      transferTo: extra.transferTo ?? null,
    })
    .returning({ id: schema.accountRequests.id });
  return row.id;
}

/**
 * Decide as a specific user.
 *
 * decide_account_request() reads current_user_id(), which resolves through
 * auth.uid(). becomeUser() sets the session claim the harness's auth.uid()
 * reads, so this is how a test says "this is Morgan clicking approve" -- and
 * approving is refused for the requester, which cannot be tested at all
 * without a real identity behind the call.
 */
async function decideAs(userId: string, requestId: string, approve: boolean) {
  const rows = await db.execute<{ auth_id: string }>(
    sql`update users set auth_id = coalesce(auth_id, uuid_generate_v4()) where id = ${userId} returning auth_id`,
  );
  const list = Array.isArray(rows) ? rows : (rows as { rows: { auth_id: string }[] }).rows;

  await becomeUser(pg, list[0].auth_id);
  try {
    const out = await db.execute<{ decide_account_request: string }>(
      sql`select decide_account_request(${requestId}, ${approve}, 'ok') as decide_account_request`,
    );
    const outList = Array.isArray(out)
      ? out
      : (out as { rows: { decide_account_request: string }[] }).rows;
    return outList[0].decide_account_request;
  } finally {
    // Back to superuser, or the next fixture insert runs under RLS as a broker
    // and quietly writes nothing.
    await becomeService(pg);
  }
}

// ---------------------------------------------------------------------------

describe("the clock override", () => {
  it("leaves an account overdue until an approval lands", async () => {
    const id = await makeAccount(dana, 50);
    expect((await stateOf(id)).state).toBe("overdue");
  });

  it("reports 'protected' while an override is live", async () => {
    const id = await makeAccount(dana, 50);
    await db.execute(sql`
      update accounts set retention_override_until = now() + interval '30 days' where id = ${id}
    `);
    const { state, daysLeft } = await stateOf(id);
    expect(state).toBe("protected");
    // Days left becomes days of protection remaining -- the number the holder
    // actually needs, rather than a negative count against a rule on hold.
    expect(daysLeft).toBeGreaterThan(28);
    expect(daysLeft).toBeLessThanOrEqual(30);
  });

  it("falls back to the ordinary clock once the override lapses", async () => {
    const id = await makeAccount(dana, 50);
    await db.execute(sql`
      update accounts set retention_override_until = now() - interval '1 day' where id = ${id}
    `);
    expect((await stateOf(id)).state).toBe("overdue");
  });

  it("keeps the nightly sweep off a protected account", async () => {
    const protectedId = await makeAccount(dana, 50);
    const exposedId = await makeAccount(kai, 50);
    await db.execute(sql`
      update accounts set retention_override_until = now() + interval '10 days' where id = ${protectedId}
    `);

    await db.execute(sql`select release_overdue_accounts()`);

    const rows = await db.execute<{ id: string; owner_id: string | null }>(
      sql`select id, owner_id from accounts order by id`,
    );
    const list = Array.isArray(rows) ? rows : (rows as { rows: { id: string; owner_id: string | null }[] }).rows;
    const byId = new Map(list.map((r) => [r.id, r.owner_id]));

    // The approval has to bind the job that actually releases things. An
    // override that shows on screen and is ignored overnight is the worst
    // possible split between what the system says and what it does.
    expect(byId.get(protectedId)).toBe(dana);
    expect(byId.get(exposedId)).toBeNull();
  });
});

describe("deciding a request", () => {
  it("grants exactly the days that were asked for", async () => {
    const id = await makeAccount(dana, 50);
    const req = await raise(id, dana, "amnesty", { days: 45 });

    expect(await decideAs(manager, req, true)).toBe("approved");

    const { state, daysLeft } = await stateOf(id);
    expect(state).toBe("protected");
    expect(daysLeft).toBeGreaterThan(43);
    expect(daysLeft).toBeLessThanOrEqual(45);
  });

  it("does not forge last_activity_at to buy the time", async () => {
    const id = await makeAccount(dana, 50);
    const before = await db.execute<{ last_activity_at: string }>(
      sql`select last_activity_at from accounts where id = ${id}`,
    );
    const beforeList = Array.isArray(before)
      ? before
      : (before as { rows: { last_activity_at: string }[] }).rows;

    await decideAs(manager, await raise(id, dana, "amnesty", { days: 30 }), true);

    const after = await db.execute<{ last_activity_at: string }>(
      sql`select last_activity_at from accounts where id = ${id}`,
    );
    const afterList = Array.isArray(after)
      ? after
      : (after as { rows: { last_activity_at: string }[] }).rows;

    // That column means "the last time an approved activity landed here".
    // Moving it to buy time would make the activity history lie about work
    // that never happened -- exactly the record a dispute turns on.
    expect(String(afterList[0].last_activity_at)).toBe(String(beforeList[0].last_activity_at));
  });

  it("changes nothing when denied", async () => {
    const id = await makeAccount(dana, 50);
    const req = await raise(id, dana, "amnesty", { days: 30 });

    expect(await decideAs(manager, req, false)).toBe("denied");
    expect((await stateOf(id)).state).toBe("overdue");
  });

  it("refuses to let somebody approve their own request", async () => {
    const id = await makeAccount(dana, 50);
    const req = await raise(id, dana, "amnesty", { days: 30 });

    expect(await decideAs(dana, req, true)).toMatch(/cannot decide your own/i);
    expect((await stateOf(id)).state).toBe("overdue");
  });

  it("refuses a request that has already been decided", async () => {
    const id = await makeAccount(dana, 50);
    const req = await raise(id, dana, "amnesty", { days: 30 });

    await decideAs(manager, req, true);
    expect(await decideAs(manager, req, true)).toMatch(/already approved/i);
  });

  it("allows only one open request per account", async () => {
    const id = await makeAccount(dana, 50);
    await raise(id, dana, "amnesty", { days: 30 });

    // Two approvers granting the same ask would stack the days silently.
    await expect(raise(id, kai, "amnesty", { days: 30 })).rejects.toThrow();
  });

  it("reopens the account for a second ask once the first is settled", async () => {
    const id = await makeAccount(dana, 50);
    const first = await raise(id, dana, "amnesty", { days: 30 });
    await decideAs(manager, first, false);

    await expect(raise(id, dana, "amnesty", { days: 30 })).resolves.toBeTruthy();
  });
});

describe("the other kinds", () => {
  it("promotes a national account and records who approved it", async () => {
    const id = await makeAccount(dana, 5, "customer");
    const req = await raise(id, dana, "national");

    await decideAs(manager, req, true);

    const rows = await db.execute<{ national_account: boolean; national_account_approved_by: string }>(
      sql`select national_account, national_account_approved_by from accounts where id = ${id}`,
    );
    const list = Array.isArray(rows)
      ? rows
      : (rows as { rows: { national_account: boolean; national_account_approved_by: string }[] }).rows;
    expect(list[0].national_account).toBe(true);
    expect(list[0].national_account_approved_by).toBe(manager);
  });

  it("hands an account over on an approved transfer, and restarts its clock", async () => {
    const id = await makeAccount(dana, 40);
    const req = await raise(id, dana, "transfer", { transferTo: kai });

    await decideAs(manager, req, true);

    const rows = await db.execute<{ owner_id: string }>(
      sql`select owner_id from accounts where id = ${id}`,
    );
    const list = Array.isArray(rows) ? rows : (rows as { rows: { owner_id: string }[] }).rows;
    expect(list[0].owner_id).toBe(kai);
    // The receiving broker should not inherit somebody else's neglect.
    expect((await stateOf(id)).state).toBe("fresh");
  });

  it("returns an account to the pool on an approved early release", async () => {
    const id = await makeAccount(dana, 5);
    const req = await raise(id, dana, "release");

    await decideAs(manager, req, true);
    expect((await stateOf(id)).state).toBe("available");
  });

  it("insists on a target for a transfer", async () => {
    const id = await makeAccount(dana, 5);
    await expect(raise(id, dana, "transfer")).rejects.toThrow();
  });

  it("insists on a reason", async () => {
    const id = await makeAccount(dana, 5);
    await expect(
      db.insert(schema.accountRequests).values({
        accountId: id,
        requestedBy: dana,
        kind: "amnesty",
        reason: "   ",
        days: 30,
      }),
    ).rejects.toThrow();
  });
});
