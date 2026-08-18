import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * A contact belongs to its account, and the account belongs to whoever holds it.
 *
 * ===========================================================================
 * Alex: "contacts linked to an account must be locked to that brokers view. of
 * course managers can see it. but please treat contacts as part of an account
 * and if an account is taken by someone. Someone else cannot pop in and find
 * their contact info."
 *
 * WHY THIS FILE EXISTS EVEN THOUGH THE RULE ALREADY WORKED
 *
 * The policy has been right since 0002: contacts inherit visibility from their
 * parent account rather than restating the ownership rule. One source of truth,
 * and it held.
 *
 * But a contact is the single most valuable row in this database -- it is a
 * named buyer with a direct line -- and there are five separate ways to reach
 * one: the contacts table, the Contacts screen's join, the command palette, a
 * phone-number lookup, and the counts on a list. Four of those five do not go
 * through the account at all in any way a reader would notice. The rule holding
 * today is not the same as the rule being checked.
 *
 * So every route is exercised here, by name, as a real signed-in user against
 * real policies. A future migration that adds a sixth route has a file to add
 * itself to.
 * ===========================================================================
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000b1",
  /** Holds the account. */
  dana: "00000000-0000-0000-0000-0000000000d1",
  /** Reports to the same manager. The colleague who must be shut out. */
  raj: "00000000-0000-0000-0000-0000000000e1",
  credit: "00000000-0000-0000-0000-0000000000c1",
};

const ids: Record<string, string> = {};

/** The details that must not travel. */
const BUYER = {
  first: "Priya",
  last: "Raman",
  email: "priya@tanglewood.test",
  phone: "+17045550142",
};

beforeAll(async () => {
  pg = await createLocalDb();
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await becomeService(pg);
  for (const t of [
    "activities", "unmatched_activities", "account_requests", "account_claims",
    "contacts", "opportunities", "accounts", "user_preferences", "users",
  ]) {
    await pg.exec(`delete from ${t};`);
  }

  const mk = async (name: string, role: string, auth: string, manager: string | null) => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id, location)
       values ($1,$2,$3,$4,$5,'Charlotte') returning id`,
      [`${name.toLowerCase()}@megaforce.test`, name, role, auth, manager],
    );
    return rows[0].id;
  };

  ids.admin = await mk("Avery", "admin", AUTH.admin, null);
  ids.credit = await mk("Casey", "credit", AUTH.credit, null);
  ids.manager = await mk("Morgan", "manager", AUTH.manager, ids.admin);
  ids.dana = await mk("Dana", "broker", AUTH.dana, ids.manager);
  ids.raj = await mk("Raj", "broker", AUTH.raj, ids.manager);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, industry, billing_city, billing_state, owner_id)
     values ('Tanglewood Milling','prospect','Nuts/Grains','Stockton','CA',$1),
            ('Free Co','prospect','Retail','Raleigh','NC',null)
     returning id`,
    [ids.dana],
  );
  ids.held = rows[0].id;
  ids.pool = rows[1].id;

  await pg.query(
    `insert into contacts (account_id, first_name, last_name, title, email, phone_e164)
     values ($1,$2,$3,'Director of Logistics',$4,$5)`,
    [ids.held, BUYER.first, BUYER.last, BUYER.email, BUYER.phone],
  );
  // A contact on an unclaimed account, which everybody may see -- the control
  // case. Without it these tests would pass on a policy that hid every contact
  // from everybody.
  await pg.query(
    `insert into contacts (account_id, first_name, last_name, email, phone_e164)
     values ($1,'Open','Person','open@freeco.test','+19195550101')`,
    [ids.pool],
  );
});

async function asUser<T>(auth: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query<T>(sql, params);
  return rows as T[];
}

// ===========================================================================
describe("the five ways to reach a contact", () => {
  it("1. the contacts table itself", async () => {
    expect(
      await asUser(AUTH.raj, `select id from contacts where account_id = $1`, [ids.held]),
    ).toHaveLength(0);
  });

  it("2. the Contacts screen, which joins through the account", async () => {
    // The screen selects contacts with accounts(...) embedded. PostgREST turns
    // that into this join, and the policy has to survive it.
    const rows = await asUser<{ email: string }>(
      AUTH.raj,
      `select c.email from contacts c join accounts a on a.id = c.account_id`,
    );
    expect(rows.map((r) => r.email)).toEqual(["open@freeco.test"]);
  });

  it("3. the command palette, searching by name", async () => {
    const rows = await asUser(
      AUTH.raj,
      `select id from contacts
        where first_name ilike '%' || $1 || '%' or last_name ilike '%' || $1 || '%'`,
      [BUYER.last],
    );
    expect(rows).toHaveLength(0);
  });

  it("4. a phone number pasted out of a call log", async () => {
    // The most likely accidental route: an unrecognised number comes in,
    // somebody pastes it into a search box, and a colleague's buyer comes back.
    expect(
      await asUser(AUTH.raj, `select id from contacts where phone_e164 = $1`, [BUYER.phone]),
    ).toHaveLength(0);
  });

  it("5. an email address", async () => {
    expect(
      await asUser(AUTH.raj, `select id from contacts where email = $1`, [BUYER.email]),
    ).toHaveLength(0);
  });

  it("and the count of them, which is a leak of a different size", async () => {
    // "3 contacts" on a locked row says a colleague has done the work. It is
    // less than the names, and it is not nothing.
    await becomeUser(pg, AUTH.raj);
    const { rows } = await pg.query<{ contact_count: number | null; can_open: boolean }>(
      `select contact_count, can_open from prospect_list('Tanglewood','all','','','','relevance',10,0)`,
    );
    expect(rows[0].can_open).toBe(false);
    expect(rows[0].contact_count).toBeNull();
  });
});

// ===========================================================================
describe("who does get through", () => {
  it("the holder", async () => {
    const rows = await asUser<{ email: string }>(
      AUTH.dana,
      `select email from contacts where account_id = $1`,
      [ids.held],
    );
    expect(rows.map((r) => r.email)).toEqual([BUYER.email]);
  });

  it("their manager, who Alex said has full visibility", async () => {
    expect(
      await asUser(AUTH.manager, `select id from contacts where account_id = $1`, [ids.held]),
    ).toHaveLength(1);
  });

  it("credit and an admin, who sit outside the hierarchy", async () => {
    for (const who of [AUTH.credit, AUTH.admin]) {
      expect(
        await asUser(who, `select id from contacts where account_id = $1`, [ids.held]),
        who,
      ).toHaveLength(1);
    }
  });

  it("everybody, for a contact on an unclaimed account", async () => {
    for (const who of Object.values(AUTH)) {
      const rows = await asUser(
        who,
        `select id from contacts where account_id = $1`,
        [ids.pool],
      );
      expect(rows, who).toHaveLength(1);
    }
  });

  it("nobody at all without a session", async () => {
    /*
     * Signed out has to be built by hand here.
     *
     * becomeUser(pg, "") clears the session AND drops back to superuser, which
     * bypasses row level security unconditionally -- so it would prove the
     * opposite of what it looks like it proves. What the application actually
     * presents is the app_user role carrying no JWT claim, which is what an
     * expired cookie looks like to Postgres.
     */
    await becomeService(pg);
    await pg.exec("set role app_user;");
    const { rows } = await pg.query(`select id from contacts`);
    await pg.exec("reset role;");
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("writing, not just reading", () => {
  it("a colleague cannot add a contact to an account they do not hold", async () => {
    await becomeUser(pg, AUTH.raj);
    await expect(
      pg.query(
        `insert into contacts (account_id, first_name, last_name) values ($1,'Sneaky','Insert')`,
        [ids.held],
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("a colleague cannot edit one, and is told nothing by trying", async () => {
    // An UPDATE that RLS filters out matches zero rows and reports success.
    // That is the silent no-op this project has been bitten by six times, so
    // the assertion is on the row count rather than on an error.
    await becomeUser(pg, AUTH.raj);
    const res = await pg.query(
      `update contacts set email = 'stolen@example.test' where phone_e164 = $1 returning id`,
      [BUYER.phone],
    );
    expect(res.rows).toHaveLength(0);

    await becomeService(pg);
    const { rows } = await pg.query<{ email: string }>(
      `select email from contacts where phone_e164 = $1`,
      [BUYER.phone],
    );
    expect(rows[0].email).toBe(BUYER.email);
  });

  it("a colleague cannot delete one", async () => {
    await becomeUser(pg, AUTH.raj);
    const res = await pg.query(`delete from contacts where phone_e164 = $1 returning id`, [
      BUYER.phone,
    ]);
    expect(res.rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("when the account goes back to the pool", () => {
  it("the contacts open up with it", async () => {
    // The other half of the rule, and the half that would be easy to get wrong
    // by locking contacts to a person instead of to the account. Alex: "Only
    // after it is set as an available account can everyone look at the info."
    await becomeService(pg);
    await pg.query(`update accounts set owner_id = null where id = $1`, [ids.held]);

    const rows = await asUser<{ email: string }>(
      AUTH.raj,
      `select email from contacts where account_id = $1`,
      [ids.held],
    );
    expect(rows.map((r) => r.email)).toEqual([BUYER.email]);
  });

  it("and close again the moment somebody else claims it", async () => {
    await becomeService(pg);
    await pg.query(`update accounts set owner_id = null where id = $1`, [ids.held]);
    await pg.query(`update accounts set owner_id = $2 where id = $1`, [ids.held, ids.raj]);

    expect(
      await asUser(AUTH.dana, `select id from contacts where account_id = $1`, [ids.held]),
    ).toHaveLength(0);
  });
});
