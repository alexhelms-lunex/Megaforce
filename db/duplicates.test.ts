import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createLocalDrizzle, type LocalDrizzle } from "./drizzle-local";
import { becomeService, becomeUser, type LocalDb } from "./local";
import * as schema from "../src/lib/db/schema";

/**
 * The duplicate guard.
 *
 * A rule about who is allowed to create which company, which means it is a rule
 * people will push on. It is tested here rather than trusted to the form,
 * because the form is one of four doors into this table -- the import, the
 * review queue and the API are the others -- and a check that lives in a screen
 * protects a screen.
 *
 * Every test drives the database as a specific signed-in person, because the
 * whole rule turns on who is asking.
 */

let db: LocalDrizzle;
let pg: LocalDb;
let broker: string;
let manager: string;
let credit: string;

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
});

afterAll(async () => {
  await pg?.close();
});

async function makeUser(email: string, name: string, role: string): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({ email, fullName: name, role })
    .returning({ id: schema.users.id });
  return row.id;
}

beforeEach(async () => {
  await becomeService(pg);
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
  `);
  broker = await makeUser("dana@megaforce.test", "Dana Whitfield", "broker");
  manager = await makeUser("morgan@megaforce.test", "Morgan Reyes", "manager");
  credit = await makeUser("casey@megaforce.test", "Casey Lin", "credit");
});

const rows = <T>(r: unknown): T[] =>
  Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);

/** Sign in as somebody, run something, and always sign back out. */
async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const found = rows<{ auth_id: string }>(
    await db.execute(
      sql`update users set auth_id = coalesce(auth_id, uuid_generate_v4()) where id = ${userId} returning auth_id`,
    ),
  );
  await becomeUser(pg, found[0].auth_id);
  try {
    return await fn();
  } finally {
    await becomeService(pg);
  }
}

interface NewAccount {
  name: string;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  owner?: string | null;
}

async function create(a: NewAccount) {
  return db.execute(sql`
    insert into accounts (name, owner_id, status, billing_street, billing_city, billing_state, phone_e164)
    values (${a.name}, ${a.owner ?? null}, 'prospect',
            ${a.street ?? null}, ${a.city ?? null}, ${a.state ?? null}, ${a.phone ?? null})
    returning id
  `);
}


/**
 * Drizzle wraps a driver error as "Failed query: ..." and hangs the real one on
 * `cause`. Asserting on the outer message would pass for any failure at all,
 * which is worse than not asserting -- so unwrap first.
 */
async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected this to be refused, but it succeeded").toBeDefined();
  const err = caught as { message?: string; cause?: { message?: string } };
  const message = `${err.cause?.message ?? ""} ${err.message ?? ""}`;
  expect(message).toMatch(pattern);
}

/** Fails with the real reason rather than "Failed query", which explains nothing. */
async function succeeds(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    throw new Error(`expected this to be allowed: ${e.cause?.message ?? e.message}`);
  }
}

const HALVORSEN: NewAccount = {
  name: "Halvorsen Foods, Inc.",
  street: "4120 Distribution Drive",
  city: "Charlotte",
  state: "NC",
  phone: "+17045550142",
};

// ---------------------------------------------------------------------------

describe("what counts as the same company", () => {
  it.each([
    ["the identical name", "Halvorsen Foods, Inc."],
    ["a different legal suffix", "Halvorsen Foods LLC"],
    ["no suffix at all", "Halvorsen Foods"],
    ["different punctuation", "Halvorsen-Foods"],
    ["different case and spacing", "  halvorsen   foods  "],
    ["a trailing Corp", "Halvorsen Foods Corp."],
  ])("catches %s", async (_label, name) => {
    await create(HALVORSEN);
    await as(broker, async () => {
      await rejectsWith(() => create({ name }), /duplicate/i);
    });
  });

  it("does not catch a genuinely different company", async () => {
    await create(HALVORSEN);
    await as(broker, async () => {
      await succeeds(() => create({ name: "Halvorsen Metals" }));
    });
  });

  it("does not treat a word inside the name as a legal suffix", async () => {
    // "Incorporated Systems" is a name; the stripper must only take a suffix
    // from the end, or two unrelated companies collapse into one.
    await create({ name: "Incorporated Systems" });
    await as(broker, async () => {
      await succeeds(() => create({ name: "Systems" }));
    });
  });

  it("catches the same main phone number on a different name", async () => {
    await create(HALVORSEN);
    await as(broker, async () => {
      await rejectsWith(() => create({ name: "Completely Different Co", phone: "+17045550142" }), /duplicate/i);
    });
  });

  it("catches the same street address on a different name", async () => {
    await create(HALVORSEN);
    await as(broker, async () => {
      await rejectsWith(() => create({
          name: "Another Company",
          street: "4120 Distribution Drive",
          city: "Charlotte",
          state: "NC",
        }), /duplicate/i);
    });
  });

  it("does not collide two companies that merely have no address", async () => {
    // Null must never match null. Otherwise the first address-less account
    // blocks every other address-less account in the system.
    await create({ name: "First Co" });
    await as(broker, async () => {
      await succeeds(() => create({ name: "Second Co" }));
    });
  });

  it("does not collide two companies that merely have no phone", async () => {
    await create({ name: "First Co", phone: null });
    await as(broker, async () => {
      await succeeds(() => create({ name: "Second Co", phone: null }));
    });
  });

  it("distinguishes the same street in two different cities", async () => {
    await create({ name: "Depot North", street: "100 Commerce Way", city: "Charlotte", state: "NC" });
    await as(broker, async () => {
      await succeeds(() => create({ name: "Depot South", street: "100 Commerce Way", city: "Atlanta", state: "GA" }));
    });
  });
});

describe("who may create one anyway", () => {
  it("refuses a broker, and names what they collided with", async () => {
    await create(HALVORSEN);
    await as(broker, async () => {
      await rejectsWith(() => create({ name: "Halvorsen Foods" }), /Halvorsen Foods/);
    });
  });

  it.each([
    ["a manager", () => manager],
    ["credit", () => credit],
  ])("allows %s", async (_label, who) => {
    await create(HALVORSEN);
    await as(who(), async () => {
      await succeeds(() => create({ name: "Halvorsen Foods" }));
    });
  });

  it("hands what they create to Credit, flagged", async () => {
    const original = rows<{ id: string }>(await create(HALVORSEN))[0].id;

    await as(manager, () => create({ name: "Halvorsen Foods" }));

    const dup = rows<{
      owner_id: string;
      duplicate_of: string;
      locked_to_credit: boolean;
      duplicate_reason: string;
    }>(
      await db.execute(sql`
        select owner_id, duplicate_of, locked_to_credit, duplicate_reason
          from accounts where id <> ${original}
      `),
    )[0];

    // Not left with the manager who typed it -- the whole point is that
    // somebody neutral decides which record is real.
    expect(dup.owner_id).toBe(credit);
    expect(dup.duplicate_of).toBe(original);
    expect(dup.locked_to_credit).toBe(true);
    expect(dup.duplicate_reason).toMatch(/Halvorsen/);
  });

  it("leaves it unowned rather than with the creator when no credit user exists", async () => {
    await db.execute(sql`delete from users where role = 'credit'`);
    await create(HALVORSEN);

    await as(manager, () => create({ name: "Halvorsen Foods" }));

    const dup = rows<{ owner_id: string | null; locked_to_credit: boolean }>(
      await db.execute(sql`select owner_id, locked_to_credit from accounts where duplicate_of is not null`),
    )[0];
    expect(dup.owner_id).toBeNull();
    expect(dup.locked_to_credit).toBe(true);
  });

  it("lets the importer through, because a half-finished import is worse", async () => {
    // No session: the Salesforce import, the seed, a migration.
    await create(HALVORSEN);
    await succeeds(() => create({ name: "Halvorsen Foods" }));
  });
});

describe("a flagged duplicate belongs to credit", () => {
  async function makeFlagged(): Promise<string> {
    await create(HALVORSEN);
    await as(manager, () => create({ name: "Halvorsen Foods" }));
    return rows<{ id: string }>(
      await db.execute(sql`select id from accounts where duplicate_of is not null`),
    )[0].id;
  }

  it("refuses a broker editing it", async () => {
    const id = await makeFlagged();
    await as(broker, async () => {
      await expect(
        db.execute(sql`update accounts set industry = 'Dairy' where id = ${id}`), /Credit/i);
    });
  });

  it("refuses a manager editing it -- letting them in would defeat the flag", async () => {
    const id = await makeFlagged();
    await as(manager, async () => {
      await rejectsWith(() => db.execute(sql`update accounts set industry = 'Dairy' where id = ${id}`), /Credit/i);
    });
  });

  it("lets credit edit it", async () => {
    const id = await makeFlagged();
    await as(credit, async () => {
      await succeeds(() => db.execute(sql`update accounts set industry = 'Dairy' where id = ${id}`));
    });
  });

  it("lets credit release the lock, after which a broker may work it", async () => {
    const id = await makeFlagged();
    await as(credit, () =>
      db.execute(sql`update accounts set locked_to_credit = false where id = ${id}`),
    );
    await as(broker, async () => {
      await succeeds(() => db.execute(sql`update accounts set industry = 'Dairy' where id = ${id}`));
    });
  });
});

describe("editing an existing account", () => {
  it("does not accuse an account of duplicating itself", async () => {
    const id = rows<{ id: string }>(await create({ ...HALVORSEN, owner: broker }))[0].id;
    await as(broker, async () => {
      await succeeds(() => db.execute(sql`update accounts set industry = 'Dairy' where id = ${id}`));
    });
  });

  it("refuses a rename onto another company's name", async () => {
    await create({ name: "Halvorsen Foods" });
    const other = rows<{ id: string }>(await create({ name: "Kestrel Logistics", owner: broker }))[0].id;
    await as(broker, async () => {
      await rejectsWith(() => db.execute(sql`update accounts set name = 'Halvorsen Foods Inc' where id = ${other}`), /duplicate/i);
    });
  });

  it("skips the check entirely when nothing identifying changed", async () => {
    // An ordinary edit must not pay for a duplicate lookup on every save.
    const id = rows<{ id: string }>(await create({ ...HALVORSEN, owner: broker }))[0].id;
    await as(broker, async () => {
      await succeeds(() => db.execute(sql`update accounts set industry = 'Produce', stage = 'Pitch' where id = ${id}`));
    });
  });
});

describe("the warning shown before anybody types a record", () => {
  it("reports the collision and what matched", async () => {
    await create(HALVORSEN);
    const found = rows<{ name: string; matched_on: string }>(
      await db.execute(sql`
        select name, matched_on from find_duplicate_accounts(
          'Halvorsen Foods LLC', null, null, null, null, null)
      `),
    );
    expect(found).toHaveLength(1);
    expect(found[0].matched_on).toBe("name");
  });

  it("says which of the three matched, so the message can be specific", async () => {
    await create(HALVORSEN);
    const byPhone = rows<{ matched_on: string }>(
      await db.execute(sql`
        select matched_on from find_duplicate_accounts(
          'Totally Different', null, null, null, '+17045550142', null)
      `),
    );
    expect(byPhone[0].matched_on).toBe("phone");
  });

  it("returns nothing for a genuinely new company", async () => {
    await create(HALVORSEN);
    const found = rows<unknown>(
      await db.execute(sql`
        select * from find_duplicate_accounts('Brand New Co', '1 New St', 'Denver', 'CO', null, null)
      `),
    );
    expect(found).toHaveLength(0);
  });
});
