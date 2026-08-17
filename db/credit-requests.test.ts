import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Asking Credit for a limit.
 *
 * ---------------------------------------------------------------------------
 * The property worth protecting here is a separation-of-duties one, and it is
 * the whole reason the credit function exists apart from sales: a manager must
 * not be able to approve their own broker's credit limit. Every other kind of
 * request in this system goes to the requester's management chain, so the
 * credit case is the one exception -- and an exception nobody tests is an
 * exception that quietly stops applying.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000b1",
  dana: "00000000-0000-0000-0000-0000000000d1",
  credit: "00000000-0000-0000-0000-0000000000c1",
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
  ids.credit = await mk("Casey", "credit", AUTH.credit, null);
  ids.manager = await mk("Morgan", "manager", AUTH.manager, ids.admin);
  ids.dana = await mk("Dana", "broker", AUTH.dana, ids.manager);

  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts (name, status, owner_id, credit_limit)
     values ('Danas Mill','customer',$1, 25000) returning id`,
    [ids.dana],
  );
  ids.account = rows[0].id;
});

async function raise(amount: number | null = 75000): Promise<string> {
  await becomeUser(pg, AUTH.dana);
  const { rows } = await pg.query<{ id: string }>(
    `insert into account_requests (account_id, requested_by, kind, reason, amount)
     values ($1,$2,'credit','They want to double their lanes',$3) returning id`,
    [ids.account, ids.dana, amount],
  );
  return rows[0].id;
}

async function decide(auth: string, requestId: string, approve: boolean): Promise<string> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query<{ decide_account_request: string }>(
    `select decide_account_request($1, $2, 'noted')`,
    [requestId, approve],
  );
  return rows[0].decide_account_request;
}

describe("a credit request", () => {
  it("can be raised by the broker who holds the account", async () => {
    const id = await raise();
    await becomeService(pg);
    const { rows } = await pg.query<{ kind: string; amount: string; status: string }>(
      `select kind, amount, status from account_requests where id = $1`,
      [id],
    );
    expect(rows[0].kind).toBe("credit");
    expect(Number(rows[0].amount)).toBe(75000);
    expect(rows[0].status).toBe("pending");
  });

  it("sets the limit on the account when credit approves it", async () => {
    const id = await raise();
    expect(await decide(AUTH.credit, id, true)).toBe("approved");

    await becomeService(pg);
    const { rows } = await pg.query<{ credit_limit: string }>(
      `select credit_limit from accounts where id = $1`,
      [ids.account],
    );
    expect(Number(rows[0].credit_limit)).toBe(75000);
  });

  it("leaves the limit alone when credit denies it", async () => {
    const id = await raise();
    expect(await decide(AUTH.credit, id, false)).toBe("denied");

    await becomeService(pg);
    const { rows } = await pg.query<{ credit_limit: string }>(
      `select credit_limit from accounts where id = $1`,
      [ids.account],
    );
    expect(Number(rows[0].credit_limit)).toBe(25000);
  });

  /*
   * The separation of duties, which is the point of the whole feature.
   *
   * A manager can approve their own broker's amnesty, extension and transfer,
   * because those are sales decisions inside their own book. A credit limit is
   * not, and a manager who can grant one has made the credit function
   * decorative.
   */
  it("cannot be approved by the requester's own manager", async () => {
    const id = await raise();
    expect(await decide(AUTH.manager, id, true)).toMatch(/only customer credit/i);

    await becomeService(pg);
    const { rows } = await pg.query<{ credit_limit: string; status: string }>(
      `select a.credit_limit, r.status from accounts a
         join account_requests r on r.id = $1 where a.id = $2`,
      [id, ids.account],
    );
    expect(Number(rows[0].credit_limit)).toBe(25000);
    expect(rows[0].status).toBe("pending");
  });

  it("cannot be approved by the broker who raised it", async () => {
    const id = await raise();
    expect(await decide(AUTH.dana, id, true)).toMatch(/cannot decide your own/i);
  });

  it("can be approved by an admin, who overrides everything by design", async () => {
    const id = await raise();
    expect(await decide(AUTH.admin, id, true)).toBe("approved");
  });

  it("refuses approval with no amount rather than wiping the limit", async () => {
    // The failure this prevents: approving a request with a null amount would
    // set credit_limit to null, which every screen reads as "no limit agreed"
    // -- the exact state the request existed to end.
    const id = await raise(null);
    await becomeUser(pg, AUTH.credit);
    await expect(
      pg.query(`select decide_account_request($1, true, null)`, [id]),
    ).rejects.toThrow(/without an amount/i);

    await becomeService(pg);
    const { rows } = await pg.query<{ credit_limit: string }>(
      `select credit_limit from accounts where id = $1`,
      [ids.account],
    );
    expect(Number(rows[0].credit_limit)).toBe(25000);
  });

  it("cannot be decided twice", async () => {
    const id = await raise();
    expect(await decide(AUTH.credit, id, true)).toBe("approved");
    expect(await decide(AUTH.admin, id, false)).toMatch(/already approved/i);
  });
});

describe("the credit work queue", () => {
  it("shows credit what is waiting, oldest first", async () => {
    await raise(75000);
    await becomeService(pg);
    // A second, older request on another account.
    const { rows: acct } = await pg.query<{ id: string }>(
      `insert into accounts (name, status, owner_id) values ('Older Co','customer',$1) returning id`,
      [ids.dana],
    );
    await pg.query(
      `insert into account_requests (account_id, requested_by, kind, reason, amount, created_at)
       values ($1,$2,'credit','Older ask', 40000, now() - interval '9 days')`,
      [acct[0].id, ids.dana],
    );

    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<{ account_name: string; waiting_days: number }>(
      `select account_name, waiting_days from credit_queue(25)`,
    );
    expect(rows.map((r) => r.account_name)).toEqual(["Older Co", "Danas Mill"]);
    expect(Number(rows[0].waiting_days)).toBeGreaterThanOrEqual(9);
  });

  it("is empty for a broker, who has no business reading the queue", async () => {
    await raise();
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query(`select * from credit_queue(25)`);
    expect(rows).toHaveLength(0);
  });

  it("counts what is pending and what it is worth", async () => {
    await raise(75000);
    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<Record<string, string>>(`select * from dashboard_credit()`);
    expect(Number(rows[0].pending_credit)).toBe(1);
    expect(Number(rows[0].pending_credit_value)).toBe(75000);
  });

  /*
   * The half of Credit's job nobody raises a request for.
   *
   * An account quietly becomes a customer and no limit is ever set, so nothing
   * appears in any queue and it stays invisible until it is a bad debt.
   */
  it("surfaces customers being shipped for with no limit agreed", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into accounts (name, status, owner_id, credit_limit)
       values ('No Limit Co','customer',$1,null)`,
      [ids.dana],
    );

    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<{ account_name: string }>(`select account_name from credit_gaps(25)`);
    expect(rows.map((r) => r.account_name)).toContain("No Limit Co");
    expect(rows.map((r) => r.account_name)).not.toContain("Danas Mill");
  });
});

// ===========================================================================
describe("credit reporting", () => {
  /**
   * Turnaround is the number a credit function is judged on, and it is the one
   * nobody could see. A broker cannot quote without a limit, so every day of
   * delay is a stalled deal -- and until this existed the only person who knew
   * how long credit took was the broker who was waiting.
   */
  it("reports throughput and turnaround over a window", async () => {
    await becomeService(pg);
    // Raised five days ago, decided two days later.
    await pg.query(
      `insert into account_requests
         (account_id, requested_by, kind, reason, amount, status,
          created_at, decided_by, decided_at)
       values ($1,$2,'credit','Needs more room', 90000, 'approved',
               now() - interval '5 days', $3, now() - interval '3 days')`,
      [ids.account, ids.dana, ids.credit],
    );

    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from report_credit_summary((now() - interval '30 days')::date, now()::date)`,
    );
    expect(Number(rows[0].approved)).toBe(1);
    expect(Number(rows[0].approved_value)).toBe(90000);
    // Two days, in hours, give or take the clock.
    expect(Number(rows[0].mean_hours)).toBeGreaterThan(40);
    expect(Number(rows[0].mean_hours)).toBeLessThan(56);
  });

  it("draws a day for every day, including the ones with nothing in them", async () => {
    // A series that omits empty days slopes through the weekend as though work
    // happened, and makes a fortnight of silence look like a gentle decline.
    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<{ day: string }>(
      `select day from report_credit_decisions((now() - interval '6 days')::date, now()::date)`,
    );
    expect(rows).toHaveLength(7);
  });

  it("shows who is asking and how often they are right", async () => {
    await raise(50000);
    await becomeService(pg);
    await pg.query(
      `insert into account_requests
         (account_id, requested_by, kind, reason, amount, status, decided_by, decided_at)
       values ($1,$2,'credit','Another ask', 20000, 'denied', $3, now())`,
      [ids.account, ids.manager, ids.credit],
    );

    await becomeUser(pg, AUTH.credit);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from report_credit_by_requester((now() - interval '30 days')::date, now()::date, 25)`,
    );
    const byName = new Map(rows.map((r) => [r.requester, r]));
    expect(Number(byName.get("Dana")!.pending)).toBe(1);
    expect(Number(byName.get("Morgan")!.denied)).toBe(1);
    // Nothing decided yet for Dana, so a rate would be a made-up number.
    expect(byName.get("Dana")!.approval_rate).toBeNull();
    expect(Number(byName.get("Morgan")!.approval_rate)).toBe(0);
  });

  it("tells a broker nothing", async () => {
    await raise();
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query(
      `select * from report_credit_summary((now() - interval '30 days')::date, now()::date)`,
    );
    // The function is scoped to credit and admin, so a broker gets one empty
    // aggregate row rather than the company's credit position.
    expect(Number((rows[0] as Record<string, string>).raised ?? 0)).toBe(0);
  });
});
