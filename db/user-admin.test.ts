import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Administering people.
 *
 * ---------------------------------------------------------------------------
 * Four of these tests exist because the operation they cover can break the
 * application from the inside, and three of those four cannot be undone from
 * within the application afterwards:
 *
 *   Removing the last admin leaves nobody able to put one back.
 *   A cycle in the org chart hangs the recursive query behind every read.
 *   Deleting somebody who owns accounts breaks a foreign key.
 *   Demoting yourself needs another admin awake to reverse.
 *
 * Every one is refused in the database rather than in a form, because a form
 * can be bypassed by a second tab or by a screen somebody writes next year.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  admin2: "00000000-0000-0000-0000-0000000000a2",
  manager: "00000000-0000-0000-0000-0000000000b1",
  dana: "00000000-0000-0000-0000-0000000000d1",
  raj: "00000000-0000-0000-0000-0000000000e1",
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
  for (const t of ["activities", "account_claims", "contacts", "accounts", "users"]) {
    await pg.exec(`delete from ${t};`);
  }

  const mkUser = async (name: string, role: string, authId: string | null, managerId: string | null) => {
    const res = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id, location)
       values ($1,$2,$3,$4,$5,'Charlotte') returning id`,
      [`${name.toLowerCase()}@megaforce.test`, name, role, authId, managerId],
    );
    return res.rows[0].id;
  };

  ids.admin = await mkUser("Avery", "admin", AUTH.admin, null);
  ids.manager = await mkUser("Morgan", "manager", AUTH.manager, ids.admin);
  ids.dana = await mkUser("Dana", "broker", AUTH.dana, ids.manager);
  ids.raj = await mkUser("Raj", "broker", AUTH.raj, ids.manager);

  await pg.query(
    `insert into accounts (name, status, owner_id) values ('Dana One','prospect',$1),
                                                          ('Dana Two','prospect',$1)`,
    [ids.dana],
  );
});

/** Drizzle-free helper: run a statement and return the driver's message. */
async function refuses(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pg.query(sql, params as never[]);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected a refusal, but the statement succeeded: ${sql}`);
}

describe("the guards that cannot be bypassed by a screen", () => {
  it("refuses to demote the last active administrator", async () => {
    await becomeUser(pg, AUTH.admin);
    const message = await refuses(`select admin_set_role($1, 'manager')`, [ids.admin]);
    expect(message).toMatch(/own administrator role/i);
  });

  it("refuses to demote the last admin even from another admin's session", async () => {
    // The self-demotion check is not enough on its own: a second admin could
    // demote the first. The trigger counts what is actually left.
    await becomeService(pg);
    const other = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id) values ('two@x.test','Two','admin',$1) returning id`,
      [AUTH.admin2],
    );
    ids.admin2 = other.rows[0].id;

    await becomeUser(pg, AUTH.admin2);
    // Two admins, so demoting one is fine.
    await pg.query(`select admin_set_role($1, 'manager')`, [ids.admin]);

    // Now there is one. Demoting the last one is refused by the trigger, not by
    // the function -- a direct UPDATE hits the same wall.
    await becomeService(pg);
    const message = await refuses(`update users set role = 'broker' where id = $1`, [ids.admin2]);
    expect(message).toMatch(/last active administrator/i);
  });

  it("refuses to deactivate the last administrator", async () => {
    await becomeService(pg);
    const message = await refuses(`update users set active = false where id = $1`, [ids.admin]);
    expect(message).toMatch(/last active administrator/i);
  });

  it("refuses to make somebody their own manager", async () => {
    await becomeService(pg);
    const message = await refuses(`update users set manager_id = $1 where id = $1`, [ids.dana]);
    expect(message).toMatch(/own manager/i);
  });

  it("refuses a cycle in the org chart", async () => {
    // Dana reports to Morgan. Pointing Morgan at Dana closes the loop, and
    // visible_user_ids() walks this tree on every read in the application --
    // so a cycle here is a hung query on every screen at once, not a tidy-up
    // job for later.
    await becomeService(pg);
    const message = await refuses(`update users set manager_id = $1 where id = $2`, [
      ids.dana,
      ids.manager,
    ]);
    expect(message).toMatch(/already reports to them/i);
  });

  it("allows a legitimate reporting-line change", async () => {
    await becomeService(pg);
    await pg.query(`update users set manager_id = $1 where id = $2`, [ids.admin, ids.dana]);
    const { rows } = await pg.query<{ manager_id: string }>(
      `select manager_id from users where id = $1`,
      [ids.dana],
    );
    expect(rows[0].manager_id).toBe(ids.admin);
  });

  it("refuses to let an administrator deactivate their own login", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into users (email, full_name, role, auth_id) values ('two@x.test','Two','admin',$1)`,
      [AUTH.admin2],
    );
    await becomeUser(pg, AUTH.admin);
    const message = await refuses(`select admin_deactivate_user($1, 'keep', null)`, [ids.admin]);
    expect(message).toMatch(/your own login/i);
  });

  it("refuses everything to somebody who is not an administrator", async () => {
    await becomeUser(pg, AUTH.manager);
    expect(await refuses(`select admin_set_role($1, 'admin')`, [ids.dana])).toMatch(
      /only an administrator/i,
    );
    expect(await refuses(`select admin_deactivate_user($1, 'release', null)`, [ids.dana])).toMatch(
      /only an administrator/i,
    );
  });

  it("stamps and clears the deactivation date rather than trusting the caller", async () => {
    await becomeUser(pg, AUTH.admin);
    await pg.query(`select admin_deactivate_user($1, 'keep', null)`, [ids.raj]);
    let { rows } = await pg.query<{ deactivated_at: string | null }>(
      `select deactivated_at from users where id = $1`,
      [ids.raj],
    );
    expect(rows[0].deactivated_at).not.toBeNull();

    await pg.query(`select admin_reactivate_user($1)`, [ids.raj]);
    ({ rows } = await pg.query<{ deactivated_at: string | null }>(
      `select deactivated_at from users where id = $1`,
      [ids.raj],
    ));
    expect(rows[0].deactivated_at).toBeNull();
  });
});

describe("what happens to somebody's book when they leave", () => {
  it("releases every account to the pool by default", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ admin_deactivate_user: number }>(
      `select admin_deactivate_user($1, 'release', null)`,
      [ids.dana],
    );
    expect(Number(rows[0].admin_deactivate_user)).toBe(2);

    await becomeService(pg);
    const held = await pg.query(`select id from accounts where owner_id = $1`, [ids.dana]);
    expect(held.rows).toHaveLength(0);

    const pool = await pg.query(`select id from accounts where owner_id is null`);
    expect(pool.rows).toHaveLength(2);
  });

  it("hands the whole book to somebody when that is what a handover means", async () => {
    await becomeUser(pg, AUTH.admin);
    await pg.query(`select admin_deactivate_user($1, 'transfer', $2)`, [ids.dana, ids.raj]);

    await becomeService(pg);
    const { rows } = await pg.query(`select id from accounts where owner_id = $1`, [ids.raj]);
    expect(rows).toHaveLength(2);
  });

  it("leaves the book alone for a leave of absence", async () => {
    await becomeUser(pg, AUTH.admin);
    await pg.query(`select admin_deactivate_user($1, 'keep', null)`, [ids.dana]);

    await becomeService(pg);
    const { rows } = await pg.query(`select id from accounts where owner_id = $1`, [ids.dana]);
    expect(rows).toHaveLength(2);
  });

  it("refuses a transfer to nobody, or to somebody already deactivated", async () => {
    await becomeUser(pg, AUTH.admin);
    expect(await refuses(`select admin_deactivate_user($1, 'transfer', null)`, [ids.dana])).toMatch(
      /choose who/i,
    );

    await pg.query(`select admin_deactivate_user($1, 'keep', null)`, [ids.raj]);
    expect(
      await refuses(`select admin_deactivate_user($1, 'transfer', $2)`, [ids.dana, ids.raj]),
    ).toMatch(/not an active user/i);
  });

  it("keeps the history: a deactivated person still owns their past", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       select id, $1, 'call', 'outbound', now() - interval '2 days', true from accounts limit 1`,
      [ids.dana],
    );

    await becomeUser(pg, AUTH.admin);
    await pg.query(`select admin_deactivate_user($1, 'release', null)`, [ids.dana]);

    await becomeService(pg);
    // Deactivation, not deletion. "Who had this in March" is what a territory
    // argument turns on, and a deleted row cannot answer it.
    const { rows } = await pg.query(`select id from activities where user_id = $1`, [ids.dana]);
    expect(rows).toHaveLength(1);
  });
});

describe("the user list", () => {
  it("shows every user with the numbers that make a name mean something", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from admin_users('', '', 'all', 50, 0)`,
    );
    const dana = rows.find((r) => r.full_name === "Dana")!;
    expect(Number(dana.accounts_held)).toBe(2);
    expect(dana.manager_name).toBe("Morgan");
    expect(dana.has_login).toBe(true);
  });

  it("filters by role, by status and by search", async () => {
    await becomeUser(pg, AUTH.admin);

    const brokers = await pg.query(`select * from admin_users('', 'broker', 'all', 50, 0)`);
    expect(brokers.rows).toHaveLength(2);

    await pg.query(`select admin_deactivate_user($1, 'keep', null)`, [ids.raj]);
    const active = await pg.query(`select * from admin_users('', '', 'active', 50, 0)`);
    expect(active.rows.map((r) => (r as { full_name: string }).full_name)).not.toContain("Raj");

    const search = await pg.query(`select * from admin_users('dana', '', 'all', 50, 0)`);
    expect(search.rows).toHaveLength(1);
  });

  it("finds people who have no login yet, which is the commonest half-finished state", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into users (email, full_name, role) values ('new@megaforce.test','New Starter','broker')`,
    );
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ full_name: string }>(
      `select full_name from admin_users('', '', 'nologin', 50, 0)`,
    );
    expect(rows.map((r) => r.full_name)).toEqual(["New Starter"]);
  });

  it("shows nothing at all to somebody who is not an administrator", async () => {
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query(`select * from admin_users('', '', 'all', 50, 0)`);
    // An empty set rather than an error: this is reached from a screen they
    // should not have got to, and a stack trace is not an improvement.
    expect(rows).toHaveLength(0);
  });

  it("counts each bucket for the filter links", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ bucket: string; n: string }>(
      `select * from admin_user_counts()`,
    );
    const counts = Object.fromEntries(rows.map((r) => [r.bucket, Number(r.n)]));
    expect(counts.all).toBe(4);
    expect(counts.broker).toBe(2);
    expect(counts.admin).toBe(1);
  });

  it("reports the unfiltered row count so the screen can page", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ total_rows: string }>(
      `select total_rows from admin_users('', '', 'all', 2, 0)`,
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].total_rows)).toBe(4);
  });
});

describe("the capability matrix", () => {
  it("describes what every role can do, for every area of the application", async () => {
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query<{ capability: string; area: string; broker: boolean }>(
      `select * from role_capabilities()`,
    );
    expect(rows.length).toBeGreaterThan(15);
    expect(new Set(rows.map((r) => r.area)).size).toBeGreaterThan(4);
  });

  it("gives admins everything", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ admin: boolean; capability: string }>(
      `select capability, admin from role_capabilities()`,
    );
    const withheld = rows.filter((r) => !r.admin);
    expect(withheld.map((r) => r.capability)).toEqual([]);
  });

  it("never gives a broker an administration capability", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ broker: boolean; capability: string }>(
      `select capability, broker from role_capabilities() where area = 'Administration'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.broker)).toEqual([]);
  });

  it("lists every role the database will actually accept", async () => {
    await becomeUser(pg, AUTH.admin);
    const { rows } = await pg.query<{ key: string }>(`select key from role_catalogue()`);
    expect(rows.map((r) => r.key)).toEqual(["broker", "manager", "credit", "admin"]);
  });
});
