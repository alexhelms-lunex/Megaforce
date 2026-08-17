import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * What one broker may learn about another broker's account.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 *
 *   An account held by somebody is theirs. Nobody else opens it -- not the
 *   contacts, not the calls, not the notes, not the credit limit, not the
 *   pipeline. Everyone can still FIND it: name, address, and whose it is.
 *   Once it falls back to the available pool, everything is open again.
 *
 * WHY THIS FILE IS LONG
 *
 * A sharing rule is only worth what its worst case is worth. Every test below
 * is a way the boundary could leak that would never show up on screen: a child
 * table that forgot to check its parent, a directory that returned one column
 * too many, a claim that opened an account without closing the previous
 * holder's. Each of those looks like correct data to whoever is reading it,
 * which is exactly why none of them would be noticed.
 *
 * The cases run against real Postgres with real policies, as real signed-in
 * users. Nothing here is mocked, because a mocked policy proves nothing.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000b1",
  /** Reports to the manager. Holds the account under test. */
  dana: "00000000-0000-0000-0000-0000000000d1",
  /** Reports to the same manager. The colleague who must be shut out. */
  raj: "00000000-0000-0000-0000-0000000000e1",
  /** Reports to nobody in this tree. */
  otherBroker: "00000000-0000-0000-0000-0000000000f1",
  credit: "00000000-0000-0000-0000-0000000000c1",
  /** Co-owns the national account, and nothing else. */
  director: "00000000-0000-0000-0000-00000000000d",
};

const ids: Record<string, string> = {};

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
  ids.other = await mk("Quinn", "broker", AUTH.otherBroker, null);
  ids.director = await mk("Devon", "ad", AUTH.director, null);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts
       (name, status, industry, billing_street, billing_city, billing_state,
        billing_postal_code, domain, owner_id, ad_owner_id, credit_limit)
     values
       ('Danas Mill','prospect','Nuts/Grains','1 Mill Rd','Stockton','CA','95202',
        'danasmill.test', $1, null, 50000),
       ('Free Co','prospect','Retail','2 Open St','Raleigh','NC','27601',
        'freeco.test', null, null, null),
       ('National Foods','customer','Food Ingredients','3 Big Ave','Houston','TX','77032',
        'nationalfoods.test', $2, $3, 250000)
     returning id`,
    [ids.dana, ids.raj, ids.director],
  );
  ids.danas = rows[0].id;
  ids.free = rows[1].id;
  ids.national = rows[2].id;

  // The proprietary work: a contact, a call and an opportunity on Dana's
  // account. These are the things that must not travel.
  await pg.query(
    `insert into contacts (account_id, first_name, last_name, title, email, phone_e164)
     values ($1,'Priya','Raman','Buyer','priya@danasmill.test','+17045550142')`,
    [ids.danas],
  );
  await pg.query(
    `insert into activities (account_id, user_id, type, direction, subject, notes,
                             occurred_at, source, qualifies, qualification_reason)
     values ($1,$2,'call','outbound','Talked pricing','They ship 40 loads a week',
             now() - interval '2 days','manual', true, 'connected')`,
    [ids.danas, ids.dana],
  );
  await pg.query(
    `insert into opportunities (account_id, owner_id, name, stage, amount, close_date)
     values ($1,$2,'Q3 lanes','Quote', 120000, current_date + 30)`,
    [ids.danas, ids.dana],
  );
});

/** Read as somebody, through row level security. */
async function asUser<T>(auth: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query<T>(sql, params);
  return rows as T[];
}

// ===========================================================================
describe("an account somebody else holds", () => {
  it("is invisible in the accounts table to a colleague", async () => {
    const rows = await asUser<{ id: string }>(AUTH.raj, `select id from accounts where id = $1`, [
      ids.danas,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("hides its contacts, which are the part with the value in them", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.raj,
      `select id from contacts where account_id = $1`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);
  });

  it("hides its call history and the notes on it", async () => {
    const rows = await asUser<{ notes: string }>(
      AUTH.raj,
      `select notes from activities where account_id = $1`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);
  });

  it("hides its pipeline", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.raj,
      `select id from opportunities where account_id = $1`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);
  });

  it("hides the credit limit, the domain and the industry", async () => {
    // Through the lifecycle view as well as the table, since the view is what
    // every screen actually reads.
    const rows = await asUser<Record<string, unknown>>(
      AUTH.raj,
      `select credit_limit, domain, industry from accounts_with_state where id = $1`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot be edited by a colleague, silently or otherwise", async () => {
    await becomeUser(pg, AUTH.raj);
    const { rows } = await pg.query(
      `update accounts set name = 'Stolen' where id = $1 returning id`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);

    await becomeService(pg);
    const after = await pg.query<{ name: string }>(`select name from accounts where id = $1`, [
      ids.danas,
    ]);
    expect(after.rows[0].name).toBe("Danas Mill");
  });

  it("cannot be claimed out from under its holder", async () => {
    await becomeUser(pg, AUTH.raj);
    const { rows } = await pg.query(
      `update accounts set owner_id = $1 where id = $2 and owner_id is null returning id`,
      [ids.raj, ids.danas],
    );
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("the directory, which everyone can read", () => {
  it("lists a colleague's account with its name, address and holder", async () => {
    const rows = await asUser<Record<string, unknown>>(
      AUTH.raj,
      `select * from account_directory('Danas', '', 'all', 50, 0)`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Danas Mill");
    expect(rows[0].billing_city).toBe("Stockton");
    expect(rows[0].billing_state).toBe("CA");
    expect(rows[0].billing_street).toBe("1 Mill Rd");
    expect(rows[0].owner_name).toBe("Dana");
    // And it says plainly that this one is not theirs to open.
    expect(rows[0].can_open).toBe(false);
    expect(rows[0].available).toBe(false);
  });

  /*
   * The whole security boundary of a security definer function is its column
   * list, so the column list is asserted directly. A later migration that adds
   * a column to `accounts` cannot leak it through here without this failing.
   */
  it("returns these columns and no others", async () => {
    const rows = await asUser<Record<string, unknown>>(
      AUTH.raj,
      `select * from account_directory('', '', 'all', 1, 0)`,
    );
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "available",
        "billing_city",
        "billing_country",
        "billing_postal_code",
        "billing_state",
        "billing_street",
        "can_open",
        "id",
        "name",
        "owner_id",
        "owner_name",
        "ad_owner_id",
        "ad_owner_name",
        "total_rows",
      ].sort(),
    );
  });

  it("carries nothing proprietary in any row", async () => {
    const rows = await asUser<Record<string, unknown>>(
      AUTH.raj,
      `select * from account_directory('', '', 'all', 100, 0)`,
    );
    const forbidden = [
      "credit_limit", "domain", "industry", "status", "stage", "notes",
      "last_activity_at", "days_left", "state", "phone", "custom",
    ];
    for (const row of rows) {
      for (const column of forbidden) {
        expect(Object.keys(row)).not.toContain(column);
      }
    }
  });

  it("finds a company by city as well as by name", async () => {
    const rows = await asUser<{ name: string }>(
      AUTH.raj,
      `select name from account_directory('Stockton', '', 'all', 50, 0)`,
    );
    expect(rows.map((r) => r.name)).toContain("Danas Mill");
  });

  it("says an unclaimed account is open to anybody", async () => {
    const rows = await asUser<{ can_open: boolean; available: boolean }>(
      AUTH.otherBroker,
      `select can_open, available from account_directory('Free Co', '', 'all', 50, 0)`,
    );
    expect(rows[0].can_open).toBe(true);
    expect(rows[0].available).toBe(true);
  });

  it("counts the three buckets for the tabs", async () => {
    const rows = await asUser<Record<string, string>>(
      AUTH.raj,
      `select * from account_directory_counts()`,
    );
    // Raj runs the national account, so that is his. Dana's mill is locked to
    // him, and the pool has one in it.
    expect(Number(rows[0].mine)).toBe(1);
    expect(Number(rows[0].locked)).toBe(1);
    expect(Number(rows[0].available)).toBe(1);
    expect(Number(rows[0].total)).toBe(3);

    // The three buckets partition the whole book -- no account counted twice,
    // none missing. A directory that loses one is a company nobody can find.
    expect(
      Number(rows[0].mine) + Number(rows[0].locked) + Number(rows[0].available),
    ).toBe(Number(rows[0].total));
  });
});

// ===========================================================================
describe("who may open what", () => {
  const cases: { who: keyof typeof AUTH; account: string; open: boolean; why: string }[] = [
    { who: "dana", account: "danas", open: true, why: "her own account" },
    { who: "raj", account: "danas", open: false, why: "a colleague's account" },
    { who: "otherBroker", account: "danas", open: false, why: "a stranger's account" },
    { who: "manager", account: "danas", open: true, why: "someone reporting to them" },
    { who: "credit", account: "danas", open: true, why: "credit sees the whole book" },
    { who: "admin", account: "danas", open: true, why: "admins see everything" },
    { who: "director", account: "danas", open: false, why: "an AD is not privileged generally" },
    { who: "director", account: "national", open: true, why: "the AD co-owns this one" },
    { who: "raj", account: "national", open: true, why: "Raj is the broker running it" },
    { who: "dana", account: "national", open: false, why: "not hers, and no AD claim on it" },
    { who: "otherBroker", account: "free", open: true, why: "unclaimed" },
    { who: "raj", account: "free", open: true, why: "unclaimed" },
  ];

  for (const c of cases) {
    it(`${c.who} ${c.open ? "opens" : "cannot open"} ${c.account} — ${c.why}`, async () => {
      const rows = await asUser<{ can_open: boolean }>(
        AUTH[c.who],
        `select can_open from account_directory_one($1)`,
        [ids[c.account]],
      );
      expect(rows[0].can_open).toBe(c.open);
    });
  }

  /*
   * The directory and row level security must not disagree.
   *
   * They are two separate pieces of SQL saying the same thing, and the moment
   * they drift, a screen says "locked" over something that opens or offers an
   * Open button that 404s. This checks every account against every role.
   */
  it("agrees with row level security for every account and every role", async () => {
    for (const [who, auth] of Object.entries(AUTH)) {
      const directory = await asUser<{ id: string; can_open: boolean }>(
        auth,
        `select id, can_open from account_directory('', '', 'all', 200, 0)`,
      );
      const readable = await asUser<{ id: string }>(auth, `select id from accounts`);
      const readableIds = new Set(readable.map((r) => r.id));

      for (const entry of directory) {
        expect(
          entry.can_open,
          `${who}: directory says can_open=${entry.can_open} for ${entry.id}, ` +
            `row level security says ${readableIds.has(entry.id)}`,
        ).toBe(readableIds.has(entry.id));
      }
    }
  });
});

// ===========================================================================
describe("when an account falls back to the pool", () => {
  it("everything about it opens up again", async () => {
    // Sealed while held.
    expect(
      await asUser<{ id: string }>(AUTH.raj, `select id from contacts where account_id = $1`, [
        ids.danas,
      ]),
    ).toHaveLength(0);

    await becomeService(pg);
    await pg.query(
      `update accounts set owner_id = null, last_release_reason = 'manual' where id = $1`,
      [ids.danas],
    );

    // And open the moment it is nobody's.
    const contacts = await asUser<{ first_name: string }>(
      AUTH.raj,
      `select first_name from contacts where account_id = $1`,
      [ids.danas],
    );
    expect(contacts.map((c) => c.first_name)).toContain("Priya");

    const calls = await asUser<{ notes: string }>(
      AUTH.raj,
      `select notes from activities where account_id = $1`,
      [ids.danas],
    );
    expect(calls[0].notes).toContain("40 loads");

    const directory = await asUser<{ can_open: boolean; available: boolean }>(
      AUTH.raj,
      `select can_open, available from account_directory_one($1)`,
      [ids.danas],
    );
    expect(directory[0].can_open).toBe(true);
    expect(directory[0].available).toBe(true);
  });

  it("seals again the moment somebody else claims it", async () => {
    await becomeService(pg);
    await pg.query(`update accounts set owner_id = null where id = $1`, [ids.danas]);

    // Raj takes it. Dana, who used to hold it, must lose the inside of it.
    await becomeUser(pg, AUTH.raj);
    await pg.query(`update accounts set owner_id = $1 where id = $2 and owner_id is null`, [
      ids.raj,
      ids.danas,
    ]);

    const danaSees = await asUser<{ id: string }>(
      AUTH.dana,
      `select id from contacts where account_id = $1`,
      [ids.danas],
    );
    expect(danaSees).toHaveLength(0);

    // But she can still see that it exists and who has it, which is the whole
    // point of the directory: the alternative is her calling them again.
    const entry = await asUser<Record<string, unknown>>(
      AUTH.dana,
      `select name, owner_name, can_open from account_directory_one($1)`,
      [ids.danas],
    );
    expect(entry[0].name).toBe("Danas Mill");
    expect(entry[0].owner_name).toBe("Raj");
    expect(entry[0].can_open).toBe(false);
  });
});

// ===========================================================================
describe("the account director", () => {
  it("opens the national account they co-own, contacts and all", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into contacts (account_id, first_name, last_name, email)
       values ($1,'Hal','Nguyen','hal@nationalfoods.test')`,
      [ids.national],
    );

    const rows = await asUser<{ first_name: string }>(
      AUTH.director,
      `select first_name from contacts where account_id = $1`,
      [ids.national],
    );
    expect(rows.map((r) => r.first_name)).toContain("Hal");
  });

  it("cannot open a broker's ordinary account", async () => {
    const rows = await asUser<{ id: string }>(
      AUTH.director,
      `select id from contacts where account_id = $1`,
      [ids.danas],
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot open another account director's national account", async () => {
    await becomeService(pg);
    const { rows: other } = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id)
       values ('devon2@megaforce.test','Devon Two','ad','00000000-0000-0000-0000-00000000000e')
       returning id`,
    );
    await pg.query(`update accounts set ad_owner_id = $1 where id = $2`, [
      other[0].id,
      ids.national,
    ]);

    const rows = await asUser<{ id: string }>(
      AUTH.director,
      `select id from accounts where id = $1`,
      [ids.national],
    );
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("the manager, who has to be able to track their brokers", () => {
  it("opens both of their reports' accounts", async () => {
    const rows = await asUser<{ name: string }>(
      AUTH.manager,
      `select name from accounts order by name`,
    );
    expect(rows.map((r) => r.name)).toEqual(["Danas Mill", "Free Co", "National Foods"]);
  });

  it("cannot open an account outside their reporting line", async () => {
    await becomeService(pg);
    const { rows } = await pg.query<{ id: string }>(
      `insert into accounts (name, status, owner_id) values ('Outsider Co','prospect',$1)
       returning id`,
      [ids.other],
    );

    const seen = await asUser<{ id: string }>(AUTH.manager, `select id from accounts where id = $1`, [
      rows[0].id,
    ]);
    expect(seen).toHaveLength(0);

    // And still finds it in the directory, with Quinn's name on it.
    const entry = await asUser<Record<string, unknown>>(
      AUTH.manager,
      `select owner_name, can_open from account_directory_one($1)`,
      [rows[0].id],
    );
    expect(entry[0].owner_name).toBe("Quinn");
    expect(entry[0].can_open).toBe(false);
  });
});
