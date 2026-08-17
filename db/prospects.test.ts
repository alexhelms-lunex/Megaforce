import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, becomeUser, becomeService, type LocalDb } from "./local";

/**
 * Prospects: one list containing every company, held or not.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS ARE BEING PROVED HERE, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 *   FINDABILITY. Every company comes back to everybody. A broker typing a name
 *     must learn that a colleague holds it -- silence is what makes two people
 *     work the same buyer for a month.
 *
 *   THE LOCK. A row somebody else holds arrives with its work stripped out.
 *     Not summarised, not rounded, not zeroed: null. A zero contact count on a
 *     locked account reads as "nobody has ever been in touch with them", which
 *     is a lie that changes what somebody does next.
 *
 * The function is SECURITY DEFINER, so its column list is the entire boundary.
 * Every restricted field is asserted null here BY NAME, so adding a column to
 * the return type without deciding which side of the line it sits on fails a
 * test rather than shipping a leak.
 * ---------------------------------------------------------------------------
 */

let pg: LocalDb;

const AUTH = {
  admin: "00000000-0000-0000-0000-0000000000a1",
  manager: "00000000-0000-0000-0000-0000000000b1",
  dana: "00000000-0000-0000-0000-0000000000d1",
  raj: "00000000-0000-0000-0000-0000000000e1",
  credit: "00000000-0000-0000-0000-0000000000c1",
  director: "00000000-0000-0000-0000-00000000000d",
};

const ids: Record<string, string> = {};

/** Every column prospect_list must blank out for a row you may not open. */
const RESTRICTED = [
  "status",
  "stage",
  "phone_e164",
  "website",
  "credit_limit",
  "credit_status",
  "last_activity_at",
  "last_communicated_at",
  "contact_count",
  "child_count",
  "parent_account_name",
  "lifecycle_state",
  "days_left",
] as const;

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
  ids.director = await mk("Devon", "ad", AUTH.director, null);

  /*
   * The names are chosen to break the search, not to look tidy.
   *
   *   "Smith & Sons, Inc." has punctuation nobody retypes accurately.
   *   "Carolina Logistics Group" is only found by two words in either order.
   *   "Piedmont Freight" sits in Charlotte, so a city search must find it
   *     without the word appearing in its name.
   */
  const { rows } = await pg.query<{ id: string }>(
    `insert into accounts
       (name, status, stage, industry, billing_street, billing_city, billing_state,
        billing_postal_code, website, phone_e164, domain, owner_id, ad_owner_id,
        credit_limit, credit_status, last_activity_at, claimed_at)
     values
       ('Smith & Sons, Inc.','prospect','Pitch','Nuts/Grains','1 Mill Rd','Stockton','CA',
        '95202','https://smithandsons.test','+12095550001','smithandsons.test',
        $1, null, 50000, 'approved', now() - interval '2 days', now() - interval '20 days'),
       ('Carolina Logistics Group','customer','Closed','Third Party Logistics',
        '4 Trade St','Charlotte','NC','28202','https://carolinalogistics.test',
        '+17045550002','carolinalogistics.test', $2, null, 120000, 'approved',
        now() - interval '1 day', now() - interval '10 days'),
       ('Piedmont Freight','prospect','Lead','Building Materials','9 Depot Ave','Charlotte','NC',
        '28203','https://piedmontfreight.test','+17045550003','piedmontfreight.test',
        null, null, null, null, null, null),
       ('National Foods','customer','Quote','Food Ingredients','3 Big Ave','Houston','TX',
        '77032','https://nationalfoods.test','+18325550004','nationalfoods.test',
        $2, $3, 250000, 'approved', now() - interval '3 days', now() - interval '30 days')
     returning id`,
    [ids.dana, ids.raj, ids.director],
  );
  ids.smith = rows[0].id;      // Dana's
  ids.carolina = rows[1].id;   // Raj's, and a customer
  ids.piedmont = rows[2].id;   // unclaimed
  ids.national = rows[3].id;   // Raj's, Devon is account director

  await pg.query(
    `insert into contacts (account_id, first_name, last_name, title, email, phone_e164)
     values ($1,'Priya','Raman','Buyer','priya@smithandsons.test','+17045550142')`,
    [ids.smith],
  );
});

async function list(
  auth: string,
  args: Partial<{
    search: string; scope: string; state: string; industry: string;
    status: string; sort: string; limit: number; offset: number;
  }> = {},
): Promise<Record<string, unknown>[]> {
  await becomeUser(pg, auth);
  const { rows } = await pg.query(
    `select * from prospect_list($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      args.search ?? "", args.scope ?? "all", args.state ?? "", args.industry ?? "",
      args.status ?? "", args.sort ?? "relevance", args.limit ?? 100, args.offset ?? 0,
    ],
  );
  return rows as Record<string, unknown>[];
}

const names = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.name));

// ===========================================================================
describe("everything is findable", () => {
  it("shows a broker every company in the business, including the ones held by others", async () => {
    const rows = await list(AUTH.raj);
    expect(names(rows).sort()).toEqual([
      "Carolina Logistics Group",
      "National Foods",
      "Piedmont Freight",
      "Smith & Sons, Inc.",
    ]);
  });

  it("names the holder of an account the caller cannot open", async () => {
    const rows = await list(AUTH.raj, { search: "Smith" });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_name).toBe("Dana");
    expect(rows[0].can_open).toBe(false);
  });

  it("names the account director as well, so a national account shows both", async () => {
    const rows = await list(AUTH.dana, { search: "National Foods" });
    expect(rows[0].owner_name).toBe("Raj");
    expect(rows[0].ad_owner_name).toBe("Devon");
  });

  it("marks unclaimed accounts as available to everybody", async () => {
    const rows = await list(AUTH.dana, { search: "Piedmont" });
    expect(rows[0].available).toBe(true);
    expect(rows[0].can_open).toBe(true);
  });

  it("refuses everything to a caller with no session", async () => {
    const rows = await list("", {});
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("the lock", () => {
  it("blanks every proprietary column on an account held by somebody else", async () => {
    const rows = await list(AUTH.raj, { search: "Smith" });
    expect(rows[0].can_open).toBe(false);
    for (const column of RESTRICTED) {
      expect(rows[0][column], `${column} leaked on a locked row`).toBeNull();
    }
  });

  it("still gives the address and the industry, which is what Alex asked for", async () => {
    const [row] = await list(AUTH.raj, { search: "Smith" });
    expect(row.name).toBe("Smith & Sons, Inc.");
    expect(row.billing_street).toBe("1 Mill Rd");
    expect(row.billing_city).toBe("Stockton");
    expect(row.billing_state).toBe("CA");
    expect(row.billing_postal_code).toBe("95202");
    expect(row.industry).toBe("Nuts/Grains");
  });

  it("fills those same columns in for the holder", async () => {
    const [row] = await list(AUTH.dana, { search: "Smith" });
    expect(row.can_open).toBe(true);
    expect(row.status).toBe("prospect");
    expect(row.stage).toBe("Pitch");
    expect(Number(row.credit_limit)).toBe(50000);
    expect(Number(row.contact_count)).toBe(1);
    expect(row.lifecycle_state).not.toBeNull();
  });

  it("opens every row for a manager, who is outside the lock", async () => {
    const rows = await list(AUTH.manager);
    expect(rows.every((r) => r.can_open === true)).toBe(true);
    expect(rows.find((r) => r.name === "Smith & Sons, Inc.")?.status).toBe("prospect");
  });

  it("opens every row for credit and for an admin", async () => {
    for (const who of [AUTH.credit, AUTH.admin]) {
      const rows = await list(who);
      expect(rows.every((r) => r.can_open === true)).toBe(true);
    }
  });

  it("opens a national account to its account director but not to a stranger", async () => {
    const forDevon = await list(AUTH.director, { search: "National Foods" });
    expect(forDevon[0].can_open).toBe(true);

    const forDana = await list(AUTH.dana, { search: "National Foods" });
    expect(forDana[0].can_open).toBe(false);
    expect(forDana[0].credit_limit).toBeNull();
  });

  it("opens everything again the moment an account returns to the pool", async () => {
    await becomeService(pg);
    await pg.query(`update accounts set owner_id = null where id = $1`, [ids.smith]);

    const [row] = await list(AUTH.raj, { search: "Smith" });
    expect(row.can_open).toBe(true);
    expect(row.available).toBe(true);
    expect(row.status).toBe("prospect");
  });

  it("agrees with row level security about who may open what", async () => {
    // Two answers to "may I see this" is how a screen offers an Open button
    // that 404s. Every row, every user.
    for (const auth of Object.values(AUTH)) {
      const rows = await list(auth);
      await becomeUser(pg, auth);
      const { rows: visible } = await pg.query<{ id: string }>(`select id from accounts`);
      const allowed = new Set(visible.map((v) => v.id));
      for (const row of rows) {
        expect(row.can_open, `${row.name} for ${auth}`).toBe(allowed.has(String(row.id)));
      }
    }
  });
});

// ===========================================================================
// Alex: "Additionally I have not thoroughly tested the search company feature.
// Does it work well?" -- these are the cases it used to fail.
// ===========================================================================
describe("searching for a company", () => {
  it("finds a company whose punctuation nobody retypes", async () => {
    for (const term of ["smith and sons", "Smith & Sons", "smith sons inc", "SMITH"]) {
      const rows = await list(AUTH.dana, { search: term });
      expect(names(rows), `searched "${term}"`).toContain("Smith & Sons, Inc.");
    }
  });

  it("takes two words in either order and needs both to match", async () => {
    expect(names(await list(AUTH.dana, { search: "carolina logistics" })))
      .toEqual(["Carolina Logistics Group"]);
    expect(names(await list(AUTH.dana, { search: "logistics carolina" })))
      .toEqual(["Carolina Logistics Group"]);
    // Both words, but no single company has both.
    expect(await list(AUTH.dana, { search: "carolina piedmont" })).toHaveLength(0);
  });

  it("finds a company by the city it sits in, with the city nowhere in its name", async () => {
    expect(names(await list(AUTH.dana, { search: "charlotte" })).sort())
      .toEqual(["Carolina Logistics Group", "Piedmont Freight"]);
  });

  it("finds one by industry -- which the old search offered and never did", async () => {
    expect(names(await list(AUTH.dana, { search: "third party logistics" })))
      .toEqual(["Carolina Logistics Group"]);
  });

  it("finds one by street, by domain and by phone number", async () => {
    expect(names(await list(AUTH.dana, { search: "Depot Ave" }))).toEqual(["Piedmont Freight"]);
    expect(names(await list(AUTH.dana, { search: "piedmontfreight.test" })))
      .toEqual(["Piedmont Freight"]);
    expect(names(await list(AUTH.dana, { search: "+1 704 555 0003" })))
      .toEqual(["Piedmont Freight"]);
  });

  it("still finds a locked company by its phone number, and still hides the phone number", async () => {
    // The switchboard number is on their website; the fact that a colleague is
    // already calling it is the thing worth knowing.
    const [row] = await list(AUTH.raj, { search: "2095550001" });
    expect(row.name).toBe("Smith & Sons, Inc.");
    expect(row.phone_e164).toBeNull();
  });

  it("puts an exact name first even when another company matched earlier alphabetically", async () => {
    await becomeService(pg);
    await pg.query(
      `insert into accounts (name, status, billing_city, billing_state)
       values ('Carolina Logistics Group Holdings','prospect','Raleigh','NC')`,
    );
    const rows = await list(AUTH.dana, { search: "Carolina Logistics Group" });
    expect(names(rows)[0]).toBe("Carolina Logistics Group");
  });

  it("returns everything for an empty search rather than nothing", async () => {
    expect(await list(AUTH.dana, { search: "   " })).toHaveLength(4);
  });

  it("does not let a stray comma or bracket change what the search means", async () => {
    // PostgREST syntax cannot reach in here at all -- the term is a bound
    // parameter -- but the normaliser has to survive it too.
    const rows = await list(AUTH.dana, { search: "smith),(" });
    expect(names(rows)).toEqual(["Smith & Sons, Inc."]);
  });
});

// ===========================================================================
describe("the tabs", () => {
  it("available shows only what nobody holds", async () => {
    expect(names(await list(AUTH.dana, { scope: "available" }))).toEqual(["Piedmont Freight"]);
  });

  it("mine shows what the caller holds, and counts an account directorship", async () => {
    expect(names(await list(AUTH.dana, { scope: "mine" }))).toEqual(["Smith & Sons, Inc."]);
    expect(names(await list(AUTH.director, { scope: "mine" }))).toEqual(["National Foods"]);
  });

  it("held shows only what the caller may not open", async () => {
    expect(names(await list(AUTH.dana, { scope: "held" })).sort())
      .toEqual(["Carolina Logistics Group", "National Foods"]);
    // A manager may open everything, so nothing is held from them.
    expect(await list(AUTH.manager, { scope: "held" })).toHaveLength(0);
  });

  it("your customers means yours, not every customer in the business", async () => {
    expect(names(await list(AUTH.raj, { scope: "customers" })).sort())
      .toEqual(["Carolina Logistics Group", "National Foods"]);
    // Dana holds no customers, even though two exist.
    expect(await list(AUTH.dana, { scope: "customers" })).toHaveLength(0);
  });

  it("counts the tabs the same way the list fills them", async () => {
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from prospect_counts('', '', '', '')`,
    );
    const c = rows[0];
    expect(Number(c.total)).toBe(4);
    expect(Number(c.available)).toBe(1);
    expect(Number(c.mine)).toBe(1);
    expect(Number(c.held)).toBe(2);
    expect(Number(c.customers)).toBe(0);
  });

  it("narrows the counts with the search, so the tabs describe what is on screen", async () => {
    await becomeUser(pg, AUTH.dana);
    const { rows } = await pg.query<Record<string, string>>(
      `select * from prospect_counts('charlotte', '', '', '')`,
    );
    expect(Number(rows[0].total)).toBe(2);
    expect(Number(rows[0].available)).toBe(1);
  });
});

// ===========================================================================
describe("filters, sorting and paging", () => {
  it("filters by state case-insensitively", async () => {
    expect(names(await list(AUTH.dana, { state: "nc" })).sort())
      .toEqual(["Carolina Logistics Group", "Piedmont Freight"]);
    expect(names(await list(AUTH.dana, { state: "NC" })).sort())
      .toEqual(["Carolina Logistics Group", "Piedmont Freight"]);
  });

  it("filters by industry", async () => {
    expect(names(await list(AUTH.dana, { industry: "Building Materials" })))
      .toEqual(["Piedmont Freight"]);
  });

  it("only applies a status filter to rows whose status the caller may read", async () => {
    // Raj may not open Smith & Sons, so its status is not his to filter on --
    // and a status filter must never be a way to learn one.
    const rows = await list(AUTH.raj, { status: "prospect" });
    expect(names(rows)).toEqual(["Piedmont Freight"]);
  });

  it("sends locked rows to the bottom under a sort they have no value for", async () => {
    const rows = await list(AUTH.dana, { sort: "recent" });
    const lockedFrom = rows.findIndex((r) => r.can_open === false);
    expect(lockedFrom).toBeGreaterThan(0);
    expect(rows.slice(lockedFrom).every((r) => r.can_open === false)).toBe(true);
  });

  it("reports the same total on every page", async () => {
    const first = await list(AUTH.dana, { limit: 2, offset: 0 });
    const second = await list(AUTH.dana, { limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(Number(first[0].total_rows)).toBe(4);
    expect(Number(second[0].total_rows)).toBe(4);
    // And no row appears on both pages.
    expect(new Set([...names(first), ...names(second)]).size).toBe(4);
  });

  it("caps the page size at 200 however large a number is asked for", async () => {
    // Not an assertion about these four rows -- about the ceiling holding when
    // somebody edits the URL.
    const rows = await list(AUTH.dana, { limit: 100000 });
    expect(rows.length).toBeLessThanOrEqual(200);
  });
});
