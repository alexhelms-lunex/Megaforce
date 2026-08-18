import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createLocalDb, becomeService, type LocalDb } from "./local";

/**
 * What somebody who is not signed in can read.
 *
 * ===========================================================================
 * Supabase's publishable key is in the browser bundle on purpose. It is not a
 * secret; it authenticates as the `anon` role, and row level security is the
 * only thing between it and the whole database. So the question "what does
 * anon see" is not paranoia -- it is the actual security boundary of this
 * application, and until this file existed nothing asked it.
 *
 * The answer used to be: every unclaimed company, its address and phone
 * number, and every CONTACT on those accounts -- names, direct lines, email
 * addresses. 0005's pool clause was `owner_id is null`, which is true whoever
 * is asking, including nobody. 0032 closes it.
 *
 * A table appearing here with a count of zero is the point. Adding a table to
 * this list is the cheapest possible check on the next policy somebody writes.
 * ===========================================================================
 */

let pg: LocalDb;

/** Everything a signed-out caller must see nothing of. */
const SHOULD_BE_EMPTY = [
  "accounts",
  "accounts_with_state",
  "contacts",
  "opportunities",
  "activities",
  "unmatched_activities",
  "users",
  "saved_views",
  "account_claims",
  "field_defs",
  "qualification_rules",
  "account_retention_rules",
  "industries",
  "user_preferences",
  "account_requests",
  "raw_events",
];

beforeAll(async () => {
  pg = await createLocalDb();
  await becomeService(pg);

  const { rows: users } = await pg.query<{ id: string }>(
    `insert into users (email, full_name, role, auth_id)
     values ('dana@megaforce.test','Dana','broker','00000000-0000-0000-0000-0000000000d1')
     returning id`,
  );

  // One held and one unclaimed. The unclaimed one is the case that leaked --
  // without it, an empty result would prove nothing at all.
  const { rows: accounts } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, billing_city, billing_state, phone_e164, owner_id)
     values ('Held Co','prospect','Stockton','CA','+12095550001',$1),
            ('Pool Co','prospect','Raleigh','NC','+19195550002',null)
     returning id`,
    [users[0].id],
  );

  for (const account of accounts) {
    await pg.query(
      `insert into contacts (account_id, first_name, last_name, email, phone_e164)
       values ($1,'A','Buyer','buyer@example.test','+17045550142')`,
      [account.id],
    );
    await pg.query(
      `insert into activities (account_id, user_id, type, subject, occurred_at, source,
                               qualifies, qualification_reason)
       values ($1,$2,'call','A call', now(), 'manual', true, 'connected')`,
      [account.id, users[0].id],
    );
  }
});

afterAll(async () => {
  await pg?.close();
});

/** The app_user role carrying no JWT claim: an expired cookie, or no login. */
async function asAnonymous<T>(sql: string): Promise<T[]> {
  await becomeService(pg);
  await pg.exec("set role app_user;");
  try {
    const { rows } = await pg.query<T>(sql);
    return rows as T[];
  } finally {
    await pg.exec("reset role;");
  }
}

describe("a caller with no session", () => {
  for (const table of SHOULD_BE_EMPTY) {
    it(`reads nothing from ${table}`, async () => {
      let rows: unknown[];
      try {
        rows = await asAnonymous(`select * from ${table} limit 5`);
      } catch {
        // A refusal is a stronger answer than an empty result.
        return;
      }
      expect(rows).toHaveLength(0);
    });
  }

  it("cannot reach the available pool, which is where the hole was", async () => {
    const rows = await asAnonymous(`select id, name from accounts where owner_id is null`);
    expect(rows).toHaveLength(0);
  });

  it("cannot reach the contacts on a pool account either", async () => {
    // Contacts inherit their account's visibility, so this followed the hole
    // above without any policy of its own being wrong.
    const rows = await asAnonymous(
      `select c.email from contacts c join accounts a on a.id = c.account_id where a.owner_id is null`,
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot write to the pool either", async () => {
    await becomeService(pg);
    await pg.exec("set role app_user;");
    await expect(
      pg.query(`insert into accounts (name, status) values ('Injected','prospect')`),
    ).rejects.toThrow(/row-level security|violates|permission/i);
    await pg.exec("reset role;");
  });

  it("cannot edit an unclaimed account", async () => {
    const rows = await asAnonymous(
      `update accounts set name = 'Renamed' where owner_id is null returning id`,
    );
    expect(rows).toHaveLength(0);
  });

  it("gets nothing from the directory functions, which read past policies", async () => {
    // SECURITY DEFINER by necessity, so their own signed-in check is the only
    // thing standing there. 0024 got this right; asserting it beside the rest
    // keeps the two halves of the boundary in one place.
    for (const call of [
      `select * from account_directory('', '', 'all', 50, 0)`,
      `select * from prospect_list('', 'all', '', '', '', 'relevance', 50, 0)`,
      `select * from prospect_industries()`,
    ]) {
      expect(await asAnonymous(call), call).toHaveLength(0);
    }
  });

  it("is not fooled by a valid token belonging to nobody", async () => {
    /*
     * The likeliest real version of this attack, and the one a plain
     * `auth.uid() is not null` check would wave through.
     *
     * Supabase projects ship with email signup enabled. Anybody who fills in
     * that form gets a genuine JWT for this project -- no invitation, no
     * administrator, no row in our users table. If holding a token were enough,
     * signing yourself up would hand you the entire available pool.
     */
    await becomeService(pg);
    await pg.query(
      `select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', false)`,
    );
    await pg.exec("set role app_user;");
    try {
      const { rows: accounts } = await pg.query(`select id from accounts`);
      const { rows: contacts } = await pg.query(`select id from contacts`);
      const { rows: listed } = await pg.query(
        `select * from prospect_list('', 'all', '', '', '', 'relevance', 50, 0)`,
      );
      expect(accounts).toHaveLength(0);
      expect(contacts).toHaveLength(0);
      expect(listed).toHaveLength(0);
    } finally {
      await pg.exec("reset role;");
      await becomeService(pg);
    }
  });

  it("gets zeroes rather than counts from the tab counters", async () => {
    // These return one row whatever happens, so the assertion is on the
    // numbers in it rather than on the row count.
    const rows = await asAnonymous<Record<string, string>>(
      `select * from prospect_counts('', '', '', '')`,
    );
    expect(Number(rows[0].total)).toBe(0);
    expect(Number(rows[0].available)).toBe(0);
  });
});
