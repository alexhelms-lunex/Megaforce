import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * The available pool, as the screens actually query it.
 *
 * ---------------------------------------------------------------------------
 * The dock and the pool page both call poolAccounts() in src/lib/pool.ts, which
 * goes through PostgREST and cannot be exercised here. What CAN be exercised is
 * the thing underneath it -- the view, the filters and the ordering -- against
 * the same migrations that run in production, as a non-superuser with row level
 * security enforced.
 *
 * These queries are written to mirror what PostgREST generates from that
 * builder, statement for statement. That is the point: the screen went blank in
 * production and every layer was individually plausible, so the layer that can
 * be pinned down is pinned down.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  broker: "00000000-0000-0000-0000-0000000000d1",
  credit: "00000000-0000-0000-0000-0000000000c9",
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
  for (const t of ["activities", "contacts", "opportunities", "accounts", "users"]) {
    await pg.exec(`delete from ${t};`);
  }

  const mkUser = async (email: string, role: string, authId: string) => {
    const res = await pg.query<{ id: string }>(
      `insert into users (email, full_name, role, auth_id) values ($1, $2, $3, $4) returning id`,
      [email, email.split("@")[0], role, authId],
    );
    return res.rows[0].id;
  };

  ids.broker = await mkUser("dana@megaforce.test", "broker", AUTH.broker);
  ids.credit = await mkUser("credit@megaforce.test", "credit", AUTH.credit);

  // Three unclaimed accounts with different histories, and one held, so the
  // filter has something to exclude as well as something to find.
  const mkAccount = async (
    name: string,
    opts: {
      owner?: string | null;
      released?: string | null;
      reason?: string | null;
      industry?: string;
      city?: string;
      state?: string;
      locked?: boolean;
    } = {},
  ) => {
    const res = await pg.query<{ id: string }>(
      `insert into accounts
         (name, status, industry, billing_city, billing_state, owner_id, released_at,
          last_release_reason, locked_to_credit)
       values ($1,'prospect',$2,$3,$4,$5,
               case when $6::text is null then null else now() - ($6::text)::interval end,
               $7,$8)
       returning id`,
      [
        name,
        opts.industry ?? "Manufacturing",
        opts.city ?? "Charlotte",
        opts.state ?? "NC",
        opts.owner ?? null,
        opts.released ?? null,
        opts.reason ?? null,
        opts.locked ?? false,
      ],
    );
    return res.rows[0].id;
  };

  ids.recent = await mkAccount("Recent Release Co", { released: "2 days", reason: "expired" });
  ids.old = await mkAccount("Long Sitting Co", { released: "200 days", reason: "manual" });
  ids.never = await mkAccount("Never Claimed Co", { industry: "Retail", city: "Raleigh" });
  ids.held = await mkAccount("Held Co", { owner: ids.broker });
  ids.dupe = await mkAccount("Duplicate Co", { released: "1 day", locked: true });
});

/** Exactly the select list src/lib/pool.ts asks PostgREST for. */
const COLUMNS = `id, name, industry, status, billing_city, billing_state, stage,
                 contact_count, released_at, last_release_reason`;

async function pool(where = "", order = "released_at desc nulls last") {
  const res = await pg.query<Record<string, unknown>>(
    `select ${COLUMNS} from accounts_with_state
      where owner_id is null and locked_to_credit = false ${where}
      order by ${order}`,
  );
  return res.rows;
}

describe("what the pool contains", () => {
  it("lists every unowned account and no owned ones", async () => {
    await becomeUser(pg, AUTH.broker);
    const names = (await pool()).map((r) => r.name);
    expect(names).toContain("Recent Release Co");
    expect(names).toContain("Long Sitting Co");
    expect(names).toContain("Never Claimed Co");
    expect(names).not.toContain("Held Co");
  });

  it("hides accounts flagged as duplicates, which belong to Credit", async () => {
    await becomeUser(pg, AUTH.broker);
    expect((await pool()).map((r) => r.name)).not.toContain("Duplicate Co");
  });

  it("selects every column the screens read, so none can be missing in production", async () => {
    await becomeUser(pg, AUTH.broker);
    const [row] = await pool();
    for (const column of [
      "id",
      "name",
      "industry",
      "status",
      "billing_city",
      "billing_state",
      "stage",
      "contact_count",
      "released_at",
      "last_release_reason",
    ]) {
      expect(Object.keys(row), `missing ${column}`).toContain(column);
    }
  });

  it("counts contacts on file, which is what tells a broker it is workable", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into contacts (account_id, first_name, last_name) values ($1,'Ada','Byron')`,
      [ids.never],
    );
    await becomeUser(pg, AUTH.broker);
    const row = (await pool()).find((r) => r.name === "Never Claimed Co")!;
    expect(Number(row.contact_count)).toBe(1);
  });
});

describe("how the pool is ordered", () => {
  it("puts recently released accounts first and never-claimed ones last", async () => {
    await becomeUser(pg, AUTH.broker);
    const names = (await pool()).map((r) => r.name);
    expect(names[0]).toBe("Recent Release Co");
    expect(names.at(-1)).toBe("Never Claimed Co");
  });

  it("reverses cleanly for longest-sitting-first, with never-claimed first", async () => {
    await becomeUser(pg, AUTH.broker);
    const names = (await pool("", "released_at asc nulls first")).map((r) => r.name);
    expect(names[0]).toBe("Never Claimed Co");
    expect(names.at(-1)).toBe("Recent Release Co");
  });

  it("sorts by name when asked", async () => {
    await becomeUser(pg, AUTH.broker);
    const names = (await pool("", "name asc")).map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("narrowing the pool", () => {
  it("filters by industry", async () => {
    await becomeUser(pg, AUTH.broker);
    const rows = await pool("and industry = 'Retail'");
    expect(rows.map((r) => r.name)).toEqual(["Never Claimed Co"]);
  });

  it("matches state case-insensitively, because nobody types NC consistently", async () => {
    await becomeUser(pg, AUTH.broker);
    const rows = await pool("and billing_state ilike 'nc'");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => String(r.billing_state).toUpperCase() === "NC")).toBe(true);
  });

  it("searches name, industry, city and state together", async () => {
    await becomeUser(pg, AUTH.broker);
    const rows = await pool(
      `and (name ilike '%raleigh%' or industry ilike '%raleigh%'
            or billing_city ilike '%raleigh%' or billing_state ilike '%raleigh%')`,
    );
    expect(rows.map((r) => r.name)).toEqual(["Never Claimed Co"]);
  });
});

describe("claiming out of the pool", () => {
  it("takes the account and clears the reason it was free", async () => {
    await becomeUser(pg, AUTH.broker);

    const claimed = await pg.query<{ id: string }>(
      `update accounts set owner_id = $1, last_release_reason = null
        where id = $2 and owner_id is null returning id`,
      [ids.broker, ids.recent],
    );
    expect(claimed.rows).toHaveLength(1);

    const after = await pg.query<{ last_release_reason: string | null; owner_id: string }>(
      `select last_release_reason, owner_id from accounts where id = $1`,
      [ids.recent],
    );
    // Left behind, the new holder's record still reads "went quiet, timed out"
    // as its reason for being available -- describing somebody else's failure.
    expect(after.rows[0].last_release_reason).toBeNull();
    expect(after.rows[0].owner_id).toBe(ids.broker);
  });

  it("starts the new holder's clock at zero rather than inheriting the neglect", async () => {
    await becomeService(pg);
    // A year of silence under the previous holder.
    await pg.query(
      `update accounts set last_activity_at = now() - interval '365 days' where id = $1`,
      [ids.recent],
    );

    await becomeUser(pg, AUTH.broker);
    await pg.query(`update accounts set owner_id = $1 where id = $2 and owner_id is null`, [
      ids.broker,
      ids.recent,
    ]);

    const row = await pg.query<{ state: string; last_activity_at: string | null }>(
      `select state, last_activity_at from accounts_with_state where id = $1`,
      [ids.recent],
    );
    expect(row.rows[0].last_activity_at).toBeNull();
    expect(row.rows[0].state).not.toBe("overdue");
  });

  it("lets exactly one of two simultaneous claims win", async () => {
    await becomeUser(pg, AUTH.broker);

    const first = await pg.query(
      `update accounts set owner_id = $1 where id = $2 and owner_id is null returning id`,
      [ids.broker, ids.old],
    );
    const second = await pg.query(
      `update accounts set owner_id = $1 where id = $2 and owner_id is null returning id`,
      [ids.credit, ids.old],
    );

    expect(first.rows).toHaveLength(1);
    // The guard is in the WHERE clause, not in application code, so the loser
    // gets zero rows back and can be told the truth.
    expect(second.rows).toHaveLength(0);
  });

  it("shows an Available segment for the stretch nobody held it", async () => {
    // Claim, release, and claim again -- the shape every account in the book
    // eventually has. The gap in the middle is the segment a list of claim rows
    // cannot show, and the one a territory argument turns on.
    await becomeService(pg);
    await pg.query(
      `insert into account_claims (account_id, user_id, claimed_at, released_at, release_reason)
       values ($1, $2, now() - interval '120 days', now() - interval '90 days', 'expired'),
              ($1, $3, now() - interval '10 days', null, null)`,
      [ids.never, ids.broker, ids.credit],
    );

    const { rows } = await pg.query<{
      segment: string;
      user_name: string | null;
      days_held: string;
      release_reason: string | null;
    }>(`select * from account_ownership_timeline($1)`, [ids.never]);

    const segments = rows.map((r) => r.segment);
    expect(segments).toContain("available");

    const gap = rows.find((r) => r.segment === "available" && Number(r.days_held) > 70);
    expect(gap, "the 80-day unclaimed stretch is missing").toBeDefined();

    // And the holders are named, with the reason they lost it.
    const first = rows.find((r) => r.segment === "owned")!;
    expect(first.user_name).toBe("dana");
    expect(first.release_reason).toBe("expired");
  });

  it("counts each holder's approved activity inside their own window only", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into account_claims (account_id, user_id, claimed_at, released_at, release_reason)
       values ($1, $2, now() - interval '60 days', now() - interval '30 days', 'expired'),
              ($1, $3, now() - interval '20 days', null, null)`,
      [ids.never, ids.broker, ids.credit],
    );
    // One approved activity in each holder's window, and one in the gap that
    // belongs to neither.
    await pg.query(
      `insert into activities (account_id, user_id, type, direction, occurred_at, qualifies)
       values ($1,$2,'call','outbound', now() - interval '50 days', true),
              ($1,$2,'call','outbound', now() - interval '25 days', true),
              ($1,$3,'call','outbound', now() - interval '5 days',  true)`,
      [ids.never, ids.broker, ids.credit],
    );

    const { rows } = await pg.query<{
      segment: string;
      user_name: string | null;
      qualifying_activities: string;
    }>(`select * from account_ownership_timeline($1)`, [ids.never]);

    const owned = rows.filter((r) => r.segment === "owned");
    expect(Number(owned[0].qualifying_activities)).toBe(1);
    expect(Number(owned[1].qualifying_activities)).toBe(1);
    // The one logged while the account sat in the pool is credited to nobody.
    const total = owned.reduce((n, r) => n + Number(r.qualifying_activities), 0);
    expect(total).toBe(2);
  });

  it("returns the claimed row, which needs the SELECT policy to pass as well", async () => {
    // RETURNING is subject to the read policy, not only to WITH CHECK. An
    // earlier version of the policies satisfied the write and refused the read
    // back, which surfaced as "new row violates row-level security policy" and
    // sent everyone looking at the wrong policy entirely.
    await becomeUser(pg, AUTH.broker);
    const res = await pg.query<{ id: string; name: string }>(
      `update accounts set owner_id = $1 where id = $2 and owner_id is null
       returning id, name`,
      [ids.broker, ids.never],
    );
    expect(res.rows[0]?.name).toBe("Never Claimed Co");
  });
});
