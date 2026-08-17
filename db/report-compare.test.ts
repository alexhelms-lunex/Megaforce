import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Comparing one period against another one you choose.
 *
 * ---------------------------------------------------------------------------
 * Alex: "I would like a compare feature added to reporting. That way we can
 * compare a previous period year over year, or by week."
 *
 * The dangerous property here is not that a comparison is missing -- that is
 * visible. It is that a comparison is present and measures the WRONG WINDOW. A
 * number under a heading saying "vs last year" is read as last year's number by
 * everybody who sees it, and there is nothing on the screen to check it
 * against.
 *
 * So every case below puts a known count of calls into a specific named window
 * and asserts that asking for that window is what returns it. The dates are all
 * fixed literals rather than offsets from today: a test that computes its
 * expectation the way the code does agrees with the code while both are wrong.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = { dana: "00000000-0000-0000-0000-0000000000d1" };
const ids: Record<string, string> = {};

/* A Monday, chosen so the arithmetic below can be checked by hand. */
const THIS_WEEK_FROM = "2026-08-17";
const THIS_WEEK_TO = "2026-08-23";
const LAST_WEEK_FROM = "2026-08-10";
const LAST_WEEK_TO = "2026-08-16";
/* 364 days before THIS_WEEK_FROM, which is also a Monday. */
const YEAR_AGO_FROM = "2025-08-18";
const YEAR_AGO_TO = "2025-08-24";

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

  const { rows: users } = await pg.query<{ id: string }>(
    `insert into users (email, full_name, role, auth_id, location)
     values ('dana@megaforce.test','Dana','broker',$1,'Charlotte') returning id`,
    [AUTH.dana],
  );
  ids.dana = users[0].id;

  const { rows: accounts } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, stage, industry, billing_state, owner_id)
     values ('Dana Co','prospect','Lead','Manufacturing','NC',$1) returning id`,
    [ids.dana],
  );
  ids.acct = accounts[0].id;

  /*
   * Distinct counts per window, so a function reading the wrong one returns a
   * number that could not have come from the right one. Equal counts would let
   * an off-by-a-window bug pass.
   */
  const calls = async (on: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await pg.query(
        `insert into activities (account_id, user_id, type, direction, subject, occurred_at,
                                 source, qualifies, qualification_reason)
         values ($1,$2,'call','outbound','Call', ($3::date + interval '10 hours'),
                 'manual', true, 'connected')`,
        [ids.acct, ids.dana, on],
      );
    }
  };

  await calls(THIS_WEEK_FROM, 9);   // this week
  await calls(LAST_WEEK_FROM, 4);   // the week before
  await calls(YEAR_AGO_FROM, 2);    // fifty-two weeks back
});

async function window(
  from: string,
  to: string,
  prevFrom: string | null = null,
  prevTo: string | null = null,
): Promise<{ value: number; previous: number | null }> {
  await becomeUser(pg, AUTH.dana);
  const { rows } = await pg.query<{ value: string; previous: string | null }>(
    `select value, previous from report_window($1::date, $2::date, 'mine', $3::date, $4::date)
      where metric = 'calls'`,
    [from, to, prevFrom, prevTo],
  );
  return {
    value: Number(rows[0].value),
    previous: rows[0].previous === null ? null : Number(rows[0].previous),
  };
}

// ===========================================================================
describe("the comparison window", () => {
  it("still defaults to the period immediately before when none is given", async () => {
    // The behaviour every caller had before 0030. Callers that have not been
    // updated must not change what they show.
    const r = await window(THIS_WEEK_FROM, THIS_WEEK_TO);
    expect(r.value).toBe(9);
    expect(r.previous).toBe(4);
  });

  it("measures the week before when asked for it explicitly", async () => {
    const r = await window(THIS_WEEK_FROM, THIS_WEEK_TO, LAST_WEEK_FROM, LAST_WEEK_TO);
    expect(r.value).toBe(9);
    expect(r.previous).toBe(4);
  });

  it("measures the same week last year, which no span could have derived", async () => {
    const r = await window(THIS_WEEK_FROM, THIS_WEEK_TO, YEAR_AGO_FROM, YEAR_AGO_TO);
    expect(r.value).toBe(9);
    expect(r.previous).toBe(2);
  });

  it("counts both ends of the comparison window", async () => {
    // A window ending on the Sunday must include the Sunday. Off-by-one at this
    // boundary quietly drops a seventh of every weekly comparison.
    await becomeService(pg);
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, subject, occurred_at,
                               source, qualifies, qualification_reason)
       values ($1,$2,'call','outbound','Sunday call', ($3::date + interval '18 hours'),
               'manual', true, 'connected')`,
      [ids.acct, ids.dana, LAST_WEEK_TO],
    );
    const r = await window(THIS_WEEK_FROM, THIS_WEEK_TO, LAST_WEEK_FROM, LAST_WEEK_TO);
    expect(r.previous).toBe(5);
  });

  it("reports zero rather than null for a window with nothing in it", async () => {
    // Null would render as "no comparison" and hide a real collapse to zero.
    const r = await window(THIS_WEEK_FROM, THIS_WEEK_TO, "2024-01-01", "2024-01-07");
    expect(r.previous).toBe(0);
  });
});

// ===========================================================================
describe("the breakdown carries the comparison too", () => {
  async function breakdown(prevFrom: string | null, prevTo: string | null) {
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from report_breakdown($1::date, $2::date, 'mine', 'broker', '', 25, 0,
                                      $3::date, $4::date)`,
      [THIS_WEEK_FROM, THIS_WEEK_TO, prevFrom, prevTo],
    );
    return rows;
  }

  it("puts the comparison figures on the row, so a manager sees WHO moved", async () => {
    const rows = await breakdown(LAST_WEEK_FROM, LAST_WEEK_TO);
    const dana = rows.find((r) => r.label === "Dana");
    expect(Number(dana!.calls)).toBe(9);
    expect(Number(dana!.approved)).toBe(9);
    expect(Number(dana!.prev_calls)).toBe(4);
    expect(Number(dana!.prev_approved)).toBe(4);
  });

  it("reaches last year on the row as well as in the totals", async () => {
    const rows = await breakdown(YEAR_AGO_FROM, YEAR_AGO_TO);
    expect(Number(rows.find((r) => r.label === "Dana")!.prev_calls)).toBe(2);
  });

  it("defaults to the preceding period when no comparison is given", async () => {
    const rows = await breakdown(null, null);
    expect(Number(rows.find((r) => r.label === "Dana")!.prev_calls)).toBe(4);
  });

  it("leaves the current-period figures untouched by the comparison chosen", async () => {
    // The comparison must not be able to change the number it is comparing.
    const a = await breakdown(LAST_WEEK_FROM, LAST_WEEK_TO);
    const b = await breakdown(YEAR_AGO_FROM, YEAR_AGO_TO);
    expect(Number(a.find((r) => r.label === "Dana")!.approved))
      .toBe(Number(b.find((r) => r.label === "Dana")!.approved));
  });
});

// ===========================================================================
describe("weekly buckets", () => {
  it("starts every bucket on a Monday, matching where the app starts its weeks", async () => {
    // date_trunc('week') is ISO, so it lands on Monday. Asserted rather than
    // assumed: if it ever did not, the chart's buckets and the period's
    // boundaries would disagree by up to six days and nothing would say so.
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query<{ bucket: string }>(
      `select bucket::text from report_series($1::date, $2::date, 'mine', 'week')`,
      ["2026-07-20", THIS_WEEK_TO],
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(new Date(`${r.bucket}T00:00:00Z`).getUTCDay(), `${r.bucket} is not a Monday`).toBe(1);
    }
  });
});
