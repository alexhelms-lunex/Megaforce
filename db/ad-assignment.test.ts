import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Putting a broker on an account an Account Director opened.
 *
 * ---------------------------------------------------------------------------
 * Alex: "AD's and brokers can co own accounts... So if an account is owned by
 * an AD a manager will have to add the broker to assign them."
 *
 * WHY THIS FILE IS MOSTLY REFUSALS
 *
 * The ownership trigger refuses any owner change by somebody who is not an
 * admin. That rule is what stops a broker helping themselves to a colleague's
 * book, and this feature punches a hole in it -- so the tests that matter are
 * not the ones proving the hole works. They are the ones proving it is exactly
 * the shape it was meant to be:
 *
 *   a manager cannot take an account off a BROKER this way -- that is still a
 *     transfer request, decided by somebody else
 *   a manager cannot reach outside their own reporting line
 *   a broker cannot call it at all
 *
 * A bypass nobody has fenced is a bypass that becomes the new rule.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000b1",
  otherManager: "00000000-0000-0000-0000-0000000000b2",
  dana: "00000000-0000-0000-0000-0000000000d1",
  outsider: "00000000-0000-0000-0000-0000000000f1",
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
  for (const t of ["account_requests", "account_claims", "activities", "contacts", "accounts", "users"]) {
    await pg.exec(`delete from ${t};`);
  }

  const mk = async (name: string, role: string, auth: string, manager: string | null) => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id)
       values ($1,$2,$3,$4,$5) returning id`,
      [`${name.toLowerCase()}@megaforce.test`, name, role, auth, manager],
    );
    return rows[0].id;
  };

  ids.admin = await mk("Avery", "admin", AUTH.admin, null);
  ids.manager = await mk("Morgan", "manager", AUTH.manager, ids.admin);
  ids.otherManager = await mk("Blake", "manager", AUTH.otherManager, ids.admin);
  ids.dana = await mk("Dana", "broker", AUTH.dana, ids.manager);
  // A second broker under the same manager, so the "already belongs to a
  // broker" fence can be tested WITHOUT the reporting-line one firing first.
  ids.jo = await mk("Jo", "broker", "00000000-0000-0000-0000-0000000000d2", ids.manager);
  ids.outsider = await mk("Quinn", "broker", AUTH.outsider, ids.otherManager);
  ids.director = await mk("Devon", "ad", AUTH.director, ids.admin);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, owner_id)
     values ('National Foods','customer',$1),
            ('Danas Mill','prospect',$2),
            ('Free Co','prospect',null)
     returning id`,
    [ids.director, ids.dana],
  );
  ids.national = rows[0].id;
  ids.danas = rows[1].id;
  ids.free = rows[2].id;
});

async function assign(auth: string, accountId: string, brokerId: string): Promise<string> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query<{ assign_broker_to_account: string }>(
    `select assign_broker_to_account($1, $2)`,
    [accountId, brokerId],
  );
  return rows[0].assign_broker_to_account;
}

async function ownership(accountId: string) {
  await becomeService(pg);
  const { rows } = await pg.query<{ owner_id: string | null; ad_owner_id: string | null }>(
    `select owner_id, ad_owner_id from accounts where id = $1`,
    [accountId],
  );
  return rows[0];
}

describe("a manager adding a broker to an AD's account", () => {
  it("puts the broker on it and keeps the AD", async () => {
    expect(await assign(AUTH.manager, ids.national, ids.dana)).toBe("ok");

    const after = await ownership(ids.national);
    expect(after.owner_id).toBe(ids.dana);
    // Co-ownership is the point. Losing the account is not what "add a broker"
    // means, and ad_owner_id is the column that exists to say so.
    expect(after.ad_owner_id).toBe(ids.director);
  });

  it("leaves both of them able to open it", async () => {
    await assign(AUTH.manager, ids.national, ids.dana);

    for (const [who, auth] of [
      ["the broker", AUTH.dana],
      ["the account director", AUTH.director],
      ["the manager", AUTH.manager],
    ] as const) {
      await becomeUser(pg, auth);
      const { rows } = await pg.query(`select id from accounts where id = $1`, [ids.national]);
      expect(rows, `${who} should still see it`).toHaveLength(1);
    }
  });

  it("starts the clock on the broker", async () => {
    // The broker is the one working it now, so the deadline is theirs. An
    // assignment that left the AD's claim date in place would hand somebody an
    // account already most of the way through its window.
    await assign(AUTH.manager, ids.national, ids.dana);
    await becomeService(pg);
    const { rows } = await pg.query<{ fresh: boolean }>(
      `select claimed_at > now() - interval '1 minute' as fresh
         from accounts where id = $1`,
      [ids.national],
    );
    expect(rows[0].fresh).toBe(true);
  });

  it("works on an account nobody holds", async () => {
    expect(await assign(AUTH.manager, ids.free, ids.dana)).toBe("ok");
    expect((await ownership(ids.free)).owner_id).toBe(ids.dana);
  });

  it("says so when they already hold it", async () => {
    await assign(AUTH.manager, ids.national, ids.dana);
    expect(await assign(AUTH.manager, ids.national, ids.dana)).toMatch(/already hold/i);
  });
});

describe("the fences around it", () => {
  /*
   * The one that matters most. This function exists to add a broker to an AD's
   * account -- not to give managers a way around the transfer process, which
   * exists precisely so that taking an account off its holder is decided by
   * somebody other than the person who wants it moved.
   */
  it("refuses to take an account off a broker", async () => {
    // Jo reports to the same manager, so the reporting-line fence does not
    // fire and this tests the one it is meant to.
    const result = await assign(AUTH.manager, ids.danas, ids.jo);
    expect(result).toMatch(/transfer request/i);

    expect((await ownership(ids.danas)).owner_id).toBe(ids.dana);
  });

  it("refuses a broker outside the manager's reporting line", async () => {
    // Quinn reports to a different manager. Without this, any manager could
    // hand any account to anybody in the company.
    const result = await assign(AUTH.manager, ids.national, ids.outsider);
    expect(result).toMatch(/reports to you/i);
    expect((await ownership(ids.national)).owner_id).toBe(ids.director);
  });

  it("refuses a broker entirely", async () => {
    expect(await assign(AUTH.dana, ids.national, ids.dana)).toMatch(/manager or an administrator/i);
    expect((await ownership(ids.national)).owner_id).toBe(ids.director);
  });

  it("refuses an account director doing it to themselves", async () => {
    expect(await assign(AUTH.director, ids.national, ids.dana)).toMatch(
      /manager or an administrator/i,
    );
  });

  it("refuses somebody who has left", async () => {
    await becomeService(pg);
    await pg.query(`update users set active = false where id = $1`, [ids.dana]);
    expect(await assign(AUTH.manager, ids.national, ids.dana)).toMatch(/not here any more/i);
  });

  it("refuses an account that no longer exists", async () => {
    expect(
      await assign(AUTH.manager, "00000000-0000-0000-0000-0000000000ff", ids.dana),
    ).toMatch(/no longer exists/i);
  });

  it("lets an admin reach anywhere, which is what admin means", async () => {
    expect(await assign(AUTH.admin, ids.national, ids.outsider)).toBe("ok");
    expect((await ownership(ids.national)).owner_id).toBe(ids.outsider);
  });

  /*
   * The bypass is scoped to one account id for the length of one transaction.
   * If it leaked, a single assignment would authorise reassigning anything else
   * touched in the same statement -- which is how a narrow exception quietly
   * becomes the new rule.
   */
  it("does not authorise reassigning anything else", async () => {
    await assign(AUTH.manager, ids.national, ids.dana);

    await becomeUser(pg, AUTH.manager);
    await expect(
      pg.query(`update accounts set owner_id = $1 where id = $2`, [ids.manager, ids.danas]),
    ).rejects.toThrow(/belongs to another broker/i);
  });
});
