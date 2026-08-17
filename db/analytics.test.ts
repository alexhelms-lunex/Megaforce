import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * The reporting engine.
 *
 * ---------------------------------------------------------------------------
 * Reports are the easiest thing in an application to ship broken, because a
 * wrong number looks exactly like a right one. Nobody notices a leaderboard
 * that credits a call to the wrong broker until somebody's commission is
 * argued about.
 *
 * So the properties tested here are the ones that would be invisible on
 * screen: that a call is credited to the person who MADE it while an account
 * is credited to the person who HOLDS it, that the previous period is the same
 * length as the current one, that empty days still appear in the series, and
 * that a broker asking for 'team' cannot see past row level security.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  manager: "00000000-0000-0000-0000-0000000000b1",
  dana: "00000000-0000-0000-0000-0000000000d1",
  raj: "00000000-0000-0000-0000-0000000000e1",
  outsider: "00000000-0000-0000-0000-0000000000f1",
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

  const mkUser = async (
    name: string,
    role: string,
    authId: string,
    managerId: string | null,
    location: string | null,
  ) => {
    const res = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id, manager_id, location)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [`${name}@megaforce.test`, name, role, authId, managerId, location],
    );
    return res.rows[0].id;
  };

  ids.manager = await mkUser("Morgan", "manager", AUTH.manager, null, "Charlotte");
  ids.dana = await mkUser("Dana", "broker", AUTH.dana, ids.manager, "Charlotte");
  ids.raj = await mkUser("Raj", "broker", AUTH.raj, ids.manager, "Dallas");
  ids.outsider = await mkUser("Outsider", "broker", AUTH.outsider, null, "Denver");

  const mkAccount = async (name: string, owner: string | null, industry: string, state: string) => {
    const res = await pg.query<{ id: string }>(
      `insert into accounts (name, status, stage, industry, billing_state, owner_id)
       values ($1,'prospect','Lead',$2,$3,$4) returning id`,
      [name, industry, state, owner],
    );
    return res.rows[0].id;
  };

  ids.danaAcct = await mkAccount("Dana Co", ids.dana, "Manufacturing", "NC");
  ids.rajAcct = await mkAccount("Raj Co", ids.raj, "Retail", "TX");
  ids.outsideAcct = await mkAccount("Outside Co", ids.outsider, "Lumber", "CO");
});

/** Days ago, as the date literal the functions take. */
function ago(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function totals(scope = "team"): Promise<Record<string, { value: number; previous: number | null }>> {
  const { rows } = await pg.query<{ metric: string; value: string; previous: string | null }>(
    `select * from report_window($1::date, $2::date, $3)`,
    [ago(6), ago(0), scope],
  );
  return Object.fromEntries(
    rows.map((r) => [r.metric, { value: Number(r.value), previous: r.previous === null ? null : Number(r.previous) }]),
  );
}

describe("the window totals", () => {
  it("counts calls in the period and not outside it", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '2 days', true),
              ($1,$2,'call','outbound', now() - interval '3 days', false),
              ($1,$2,'call','outbound', now() - interval '40 days', true)`,
      [ids.danaAcct, ids.dana],
    );

    await becomeUser(pg, AUTH.manager);
    const t = await totals();
    expect(t.calls.value).toBe(2);
    expect(t.approved.value).toBe(1);
  });

  it("compares against a previous period of exactly the same length", async () => {
    await becomeService(pg);
    // Seven-day window. The comparison window is the seven days before it, so a
    // call 8 days ago belongs to "previous" and one 20 days ago belongs to
    // neither.
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '2 days', true),
              ($1,$2,'call','outbound', now() - interval '8 days', true),
              ($1,$2,'call','outbound', now() - interval '20 days', true)`,
      [ids.danaAcct, ids.dana],
    );

    await becomeUser(pg, AUTH.manager);
    const t = await totals();
    expect(t.calls.value).toBe(1);
    expect(t.calls.previous).toBe(1);
  });

  it("separates accounts lost to the clock from accounts handed back", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into account_claims (account_id, user_id, claimed_at, released_at, release_reason)
       values ($1,$2, now() - interval '30 days', now() - interval '2 days', 'expired'),
              ($1,$2, now() - interval '30 days', now() - interval '3 days', 'manual')`,
      [ids.danaAcct, ids.dana],
    );

    await becomeUser(pg, AUTH.manager);
    const t = await totals();
    expect(t.released.value).toBe(2);
    // The difference between these two is the difference between a process
    // problem and somebody's decision.
    expect(t.lost.value).toBe(1);
  });

  it("reports accounts held as a snapshot with no comparison", async () => {
    await becomeUser(pg, AUTH.manager);
    const t = await totals();
    expect(t.accounts_held.value).toBe(2); // Dana's and Raj's, not the outsider's
    expect(t.accounts_held.previous).toBeNull();
  });

  it("narrows to one person's own book when asked for 'mine'", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '1 day', true),
              ($3,$4,'call','outbound', now() - interval '1 day', true)`,
      [ids.danaAcct, ids.dana, ids.rajAcct, ids.raj],
    );

    await becomeUser(pg, AUTH.dana);
    expect((await totals("mine")).calls.value).toBe(1);

    await becomeUser(pg, AUTH.manager);
    expect((await totals("team")).calls.value).toBe(2);
  });

  it("cannot be widened past row level security by asking for 'team'", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '1 day', true)`,
      [ids.outsideAcct, ids.outsider],
    );

    // Dana asks for the team view. The outsider reports to nobody Dana can see,
    // so the parameter buys her nothing -- the policies have already decided.
    await becomeUser(pg, AUTH.dana);
    expect((await totals("team")).calls.value).toBe(0);
  });
});

describe("the time series", () => {
  it("returns every bucket in the range, including the empty ones", async () => {
    await becomeUser(pg, AUTH.manager);
    const { rows } = await pg.query(
      `select * from report_series($1::date, $2::date, 'team', 'day')`,
      [ago(6), ago(0)],
    );
    // A chart that omits quiet days draws a flat line through a holiday and
    // makes a dead week look busy.
    expect(rows).toHaveLength(7);
  });

  it("buckets by week when asked, so a long report is a trend and not noise", async () => {
    await becomeUser(pg, AUTH.manager);
    const { rows } = await pg.query(
      `select * from report_series($1::date, $2::date, 'team', 'week')`,
      [ago(83), ago(0)],
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(16);
  });

  it("puts each call in the day it happened", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '2 days', true),
              ($1,$2,'call','outbound', now() - interval '2 days', false)`,
      [ids.danaAcct, ids.dana],
    );

    await becomeUser(pg, AUTH.manager);
    const { rows } = await pg.query<{ bucket: string; calls: string; approved: string }>(
      `select * from report_series($1::date, $2::date, 'team', 'day')`,
      [ago(6), ago(0)],
    );
    const busy = rows.filter((r) => Number(r.calls) > 0);
    expect(busy).toHaveLength(1);
    expect(Number(busy[0].calls)).toBe(2);
    expect(Number(busy[0].approved)).toBe(1);
  });
});

describe("the dimension breakdown", () => {
  async function breakdown(dimension: string, scope = "team", search = "") {
    const { rows } = await pg.query<Record<string, string>>(
      `select * from report_breakdown($1::date, $2::date, $3, $4, $5, 50, 0)`,
      [ago(6), ago(0), scope, dimension, search],
    );
    return rows;
  }

  it("credits a call to the person who made it, not the account's owner", async () => {
    await becomeService(pg);
    // The manager rings Dana's account. The call is the manager's work; the
    // account is still Dana's book.
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '1 day', true)`,
      [ids.danaAcct, ids.manager],
    );

    await becomeUser(pg, AUTH.manager);
    const rows = await breakdown("broker");
    const morgan = rows.find((r) => r.key === "Morgan")!;
    const dana = rows.find((r) => r.key === "Dana")!;

    expect(Number(morgan.calls)).toBe(1);
    expect(Number(morgan.accounts)).toBe(0);
    expect(Number(dana.calls)).toBe(0);
    expect(Number(dana.accounts)).toBe(1);
  });

  it("keeps a broker with accounts and no calls in the table", async () => {
    await becomeUser(pg, AUTH.manager);
    const rows = await breakdown("broker");
    // The full join exists for this row. It is the one a manager is looking
    // for, and an inner join would drop it exactly when it matters.
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(["Dana", "Raj"]));
  });

  it("computes the hit rate from the two figures beside it", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '1 day', true),
              ($1,$2,'call','outbound', now() - interval '1 day', true),
              ($1,$2,'call','outbound', now() - interval '1 day', false),
              ($1,$2,'call','outbound', now() - interval '1 day', false)`,
      [ids.danaAcct, ids.dana],
    );

    await becomeUser(pg, AUTH.manager);
    const dana = (await breakdown("broker")).find((r) => r.key === "Dana")!;
    expect(Number(dana.hit_rate)).toBe(50);
  });

  it("groups by branch, industry and state without a new function each", async () => {
    await becomeUser(pg, AUTH.manager);

    const branches = (await breakdown("branch")).map((r) => r.key);
    expect(branches).toEqual(expect.arrayContaining(["Charlotte", "Dallas"]));

    const industries = (await breakdown("industry")).map((r) => r.key);
    expect(industries).toEqual(expect.arrayContaining(["Manufacturing", "Retail"]));

    const states = (await breakdown("state")).map((r) => r.key);
    expect(states).toEqual(expect.arrayContaining(["NC", "TX"]));
  });

  it("upper-cases states so one place is not two rows", async () => {
    await becomeService(pg);
    await pg.query(`update accounts set billing_state = 'nc' where id = $1`, [ids.rajAcct]);

    await becomeUser(pg, AUTH.manager);
    const states = (await breakdown("state")).filter((r) => r.key === "NC");
    expect(states).toHaveLength(1);
    expect(Number(states[0].accounts)).toBe(2);
  });

  it("searches within the dimension", async () => {
    await becomeUser(pg, AUTH.manager);
    const rows = await breakdown("broker", "team", "dan");
    expect(rows.map((r) => r.key)).toEqual(["Dana"]);
  });

  it("reports the unfiltered row count so the screen can page", async () => {
    await becomeUser(pg, AUTH.manager);
    const rows = await breakdown("broker");
    expect(Number(rows[0].total_rows)).toBe(rows.length);
  });

  it("never leaks a row belonging to somebody outside the caller's line", async () => {
    await becomeUser(pg, AUTH.dana);
    const rows = await breakdown("broker", "team");
    expect(rows.map((r) => r.key)).not.toContain("Outsider");
  });
});

describe("the dimension menu", () => {
  it("lists every dimension the breakdown accepts", async () => {
    await becomeUser(pg, AUTH.manager);
    const { rows } = await pg.query<{ key: string }>(`select key from report_dimensions()`);
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "broker",
        "branch",
        "industry",
        "state",
        "status",
        "stage",
        "type",
        "direction",
        "release_reason",
      ]),
    );
  });

  it("gives every dimension a hint, since the menu is where they are chosen", async () => {
    await becomeUser(pg, AUTH.manager);
    const { rows } = await pg.query<{ hint: string }>(`select hint from report_dimensions()`);
    expect(rows.every((r) => r.hint && r.hint.length > 20)).toBe(true);
  });
});
