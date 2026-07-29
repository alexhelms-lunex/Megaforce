import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Row level security, tested as a signed-in user actually experiences it.
 *
 * These run under a non-superuser role, because a superuser bypasses RLS
 * unconditionally. A suite that forgot to switch roles would pass every
 * assertion here while the policies did nothing at all -- which is the failure
 * mode worth guarding against, since it looks exactly like success.
 *
 * The org chart under test:
 *
 *     admin
 *       +-- manager                +-- otherManager
 *             +-- rep1                   +-- rep3
 *             +-- rep2
 *
 * Each rep owns one account.
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000m1".replace(/m/g, "b"),
  otherManager: "00000000-0000-0000-0000-0000000000c1",
  rep1: "00000000-0000-0000-0000-0000000000d1",
  rep2: "00000000-0000-0000-0000-0000000000e1",
  rep3: "00000000-0000-0000-0000-0000000000f1",
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
    "unmatched_activities",
    "activities",
    "raw_events",
    "contacts",
    "opportunities",
    "accounts",
    "users",
  ]) {
    await pg.exec(`delete from ${t};`);
  }

  const mkUser = async (email: string, role: string, authId: string, managerId: string | null) => {
    const res = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [email, email.split("@")[0], role, authId, managerId],
    );
    return res.rows[0].id;
  };

  ids.admin = await mkUser("admin@megaforce.test", "admin", AUTH.admin, null);
  ids.manager = await mkUser("manager@megaforce.test", "manager", AUTH.manager, ids.admin);
  ids.otherManager = await mkUser("other@megaforce.test", "manager", AUTH.otherManager, ids.admin);
  ids.rep1 = await mkUser("rep1@megaforce.test", "rep", AUTH.rep1, ids.manager);
  ids.rep2 = await mkUser("rep2@megaforce.test", "rep", AUTH.rep2, ids.manager);
  ids.rep3 = await mkUser("rep3@megaforce.test", "rep", AUTH.rep3, ids.otherManager);

  const mkAccount = async (name: string, ownerId: string) => {
    const res = await pg.query<{ id: string }>(
      `insert into accounts (name, owner_id) values ($1, $2) returning id`,
      [name, ownerId],
    );
    return res.rows[0].id;
  };

  ids.acct1 = await mkAccount("Account One", ids.rep1);
  ids.acct2 = await mkAccount("Account Two", ids.rep2);
  ids.acct3 = await mkAccount("Account Three", ids.rep3);

  for (const [account, first] of [
    [ids.acct1, "Ana"],
    [ids.acct2, "Ben"],
    [ids.acct3, "Cleo"],
  ]) {
    await pg.query(
      `insert into contacts (account_id, first_name, last_name) values ($1, $2, 'Contact')`,
      [account, first],
    );
  }
});

async function visibleAccountNames(authId: string): Promise<string[]> {
  await becomeUser(pg, authId);
  const res = await pg.query<{ name: string }>("select name from accounts order by name");
  return res.rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------

describe("who can see which accounts", () => {
  it("a rep sees only what they own", async () => {
    expect(await visibleAccountNames(AUTH.rep1)).toEqual(["Account One"]);
    expect(await visibleAccountNames(AUTH.rep3)).toEqual(["Account Three"]);
  });

  it("a manager sees their whole team, and nobody else's", async () => {
    expect(await visibleAccountNames(AUTH.manager)).toEqual(["Account One", "Account Two"]);
    expect(await visibleAccountNames(AUTH.manager)).not.toContain("Account Three");
  });

  it("an admin sees everything", async () => {
    expect(await visibleAccountNames(AUTH.admin)).toEqual([
      "Account One",
      "Account Three",
      "Account Two",
    ]);
  });

  it("reaches down the whole org chart, not just direct reports", async () => {
    // The admin manages the two managers, and only indirectly the reps who own
    // the accounts. A non-recursive policy would return nothing here.
    await becomeUser(pg, AUTH.admin);
    const res = await pg.query<{ c: string }>("select count(*)::text c from accounts");
    expect(res.rows[0].c).toBe("3");
  });

  it("shows nothing at all to an unauthenticated session", async () => {
    await becomeUser(pg, "00000000-0000-0000-0000-000000000999");
    const res = await pg.query<{ c: string }>("select count(*)::text c from accounts");
    expect(res.rows[0].c).toBe("0");
  });
});

describe("child records inherit their account's visibility", () => {
  it("hides contacts belonging to accounts you cannot see", async () => {
    await becomeUser(pg, AUTH.rep1);
    const res = await pg.query<{ first_name: string }>("select first_name from contacts");
    expect(res.rows.map((r) => r.first_name)).toEqual(["Ana"]);
  });

  it("gives a manager their team's contacts", async () => {
    await becomeUser(pg, AUTH.manager);
    const res = await pg.query<{ first_name: string }>(
      "select first_name from contacts order by first_name",
    );
    expect(res.rows.map((r) => r.first_name)).toEqual(["Ana", "Ben"]);
  });

  it("hides activities on accounts you cannot see", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, type, occurred_at, qualifies)
       values ($1, 'call', now(), true)`,
      [ids.acct3],
    );

    await becomeUser(pg, AUTH.rep1);
    const res = await pg.query<{ c: string }>("select count(*)::text c from activities");
    expect(res.rows[0].c).toBe("0");

    await becomeUser(pg, AUTH.admin);
    const all = await pg.query<{ c: string }>("select count(*)::text c from activities");
    expect(all.rows[0].c).toBe("1");
  });
});

describe("editing", () => {
  it("lets a manager fix a detail on a team account", async () => {
    await becomeUser(pg, AUTH.manager);
    await pg.query("update accounts set industry = 'Healthcare' where id = $1", [ids.acct1]);
    const res = await pg.query<{ industry: string }>(
      "select industry from accounts where id = $1",
      [ids.acct1],
    );
    expect(res.rows[0].industry).toBe("Healthcare");
  });

  it("silently changes nothing when a rep edits someone else's account", async () => {
    // RLS filters the row out of the UPDATE's scope rather than raising. The
    // statement reports zero rows affected -- which application code must treat
    // as a failure, not as success.
    await becomeUser(pg, AUTH.rep1);
    const res = await pg.query("update accounts set industry = 'Legal' where id = $1", [ids.acct3]);
    expect(res.affectedRows).toBe(0);

    await becomeService(pg);
    const check = await pg.query<{ industry: string | null }>(
      "select industry from accounts where id = $1",
      [ids.acct3],
    );
    expect(check.rows[0].industry).toBeNull();
  });
});

describe("who owns an account", () => {
  it("refuses to let a manager reassign it", async () => {
    // The decision on record: managers can correct the details of a team
    // account, but moving a rep's account to someone else is an admin action.
    // RLS grants whole rows, so this one column is protected by a trigger.
    await becomeUser(pg, AUTH.manager);
    await expect(
      pg.query("update accounts set owner_id = $1 where id = $2", [ids.rep2, ids.acct1]),
    ).rejects.toThrow(/ownership can only be changed by an admin/i);
  });

  it("allows an admin to reassign it", async () => {
    await becomeUser(pg, AUTH.admin);
    await pg.query("update accounts set owner_id = $1 where id = $2", [ids.rep2, ids.acct1]);

    await becomeService(pg);
    const res = await pg.query<{ owner_id: string }>(
      "select owner_id from accounts where id = $1",
      [ids.acct1],
    );
    expect(res.rows[0].owner_id).toBe(ids.rep2);
  });

  it("still lets a manager edit other columns on the same row", async () => {
    await becomeUser(pg, AUTH.manager);
    await pg.query("update accounts set name = 'Renamed', status = 'churned' where id = $1", [
      ids.acct1,
    ]);
    const res = await pg.query<{ name: string }>("select name from accounts where id = $1", [
      ids.acct1,
    ]);
    expect(res.rows[0].name).toBe("Renamed");
  });
});

describe("raw provider payloads", () => {
  it("are invisible to every user-facing session", async () => {
    // raw_events has RLS enabled and no policy granting anything. Payloads can
    // carry phone numbers and recording URLs that have no business on a screen.
    await becomeService(pg);
    await pg.query(
      `insert into raw_events (source, external_id, payload) values ('ringcentral','x-1','{}')`,
    );

    for (const who of [AUTH.rep1, AUTH.manager, AUTH.admin]) {
      await becomeUser(pg, who);
      const res = await pg.query<{ c: string }>("select count(*)::text c from raw_events");
      expect(res.rows[0].c, who).toBe("0");
    }

    // The service role, which is what the webhook worker uses, still sees it.
    await becomeService(pg);
    const res = await pg.query<{ c: string }>("select count(*)::text c from raw_events");
    expect(res.rows[0].c).toBe("1");
  });
});

describe("the review queue", () => {
  it("is visible to managers and admins but not to reps", async () => {
    await becomeService(pg);
    const raw = await pg.query<{ id: string }>(
      `insert into raw_events (source, external_id, payload)
       values ('ringcentral','x-2','{}') returning id`,
    );
    await pg.query(
      `insert into unmatched_activities (raw_event_id, reason, phone_e164)
       values ($1, 'no_contact_match', '+17045559999')`,
      [raw.rows[0].id],
    );

    await becomeUser(pg, AUTH.rep1);
    expect((await pg.query<{ c: string }>("select count(*)::text c from unmatched_activities")).rows[0].c).toBe("0");

    await becomeUser(pg, AUTH.manager);
    expect((await pg.query<{ c: string }>("select count(*)::text c from unmatched_activities")).rows[0].c).toBe("1");

    await becomeUser(pg, AUTH.admin);
    expect((await pg.query<{ c: string }>("select count(*)::text c from unmatched_activities")).rows[0].c).toBe("1");
  });
});

describe("configuration", () => {
  it("is readable by everyone and writable only by an admin", async () => {
    await becomeUser(pg, AUTH.rep1);
    const read = await pg.query<{ c: string }>("select count(*)::text c from qualification_rules");
    expect(Number(read.rows[0].c)).toBeGreaterThan(0);

    // A rep cannot loosen the rule that decides whether their own calls count.
    const attempt = await pg.query(
      "update qualification_rules set min_duration_seconds = 1 where activity_type = 'call'",
    );
    expect(attempt.affectedRows).toBe(0);

    await becomeUser(pg, AUTH.admin);
    const allowed = await pg.query(
      "update qualification_rules set min_duration_seconds = 60 where activity_type = 'call'",
    );
    expect(allowed.affectedRows).toBe(1);
  });
});
