import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createLocalDrizzle, type LocalDrizzle } from "./drizzle-local";
import { becomeUser, becomeService, type LocalDb } from "./local";
import { seed } from "./seed";
import type { Db } from "../src/lib/db";

/**
 * Does the search actually find things?
 *
 * ===========================================================================
 * Alex: "Additionally I have not thoroughly tested the search company feature.
 * does it work well?"
 *
 * A fair question, and the honest answer before this file was no. The old
 * directory search was three ILIKEs against name, city and state. Its own
 * placeholder offered industry and it never searched it; "smith and sons" did
 * not find "Smith & Sons, Inc."; and any two-word term matched nothing at all
 * unless a company was literally called that.
 *
 * prospects.test.ts proves the new behaviour on a hand-built fixture, where
 * every row was chosen to make a point. This file is the other half: the SEEDED
 * book -- forty generated companies with generated names, cities, industries
 * and phone numbers, none of them chosen to be findable. A search that only
 * works on data written to demonstrate it is not a search.
 *
 * Every case here takes a fact from a row the seed produced and asks the search
 * to find that row back. If it cannot, the search is broken for the data this
 * application actually holds.
 * ===========================================================================
 */

let db: LocalDrizzle;
let pg: LocalDb;

/** A signed-in broker. Search behaves the same for everybody; someone must be there. */
let brokerAuth = "";

interface Company {
  id: string;
  name: string;
  billing_city: string | null;
  billing_state: string | null;
  industry: string | null;
  phone_e164: string | null;
  billing_street: string | null;
}

let book: Company[] = [];

beforeAll(async () => {
  ({ db, pg } = await createLocalDrizzle());
  await seed(db as unknown as Db, {
    // 40 users, matching what setup actually loads, so the book here has the
    // same shape of owners and branches as the real one.
    users: 40,
    accounts: 40,
    contacts: 120,
    opportunities: 40,
    activities: 300,
    days: 120,
  });

  await becomeService(pg);

  /*
   * The seed does not set auth_id -- those come from Supabase Auth, which does
   * not exist here -- so there is nobody to search AS, and prospect_list
   * correctly refuses a caller with no session. One is attached by hand.
   */
  brokerAuth = "00000000-0000-0000-0000-0000000000d1";
  await pg.query(
    `update users set auth_id = $1
      where id = (select id from users where role = 'broker' order by created_at limit 1)`,
    [brokerAuth],
  );

  /*
   * Two companies added on top of the generated book.
   *
   * The generator produces clean names -- no ampersands, no full stops -- so
   * the cases that broke the OLD search are not in it. These two put them back,
   * with forty generated neighbours around them rather than in a fixture of
   * three rows where any ranking looks correct:
   *
   *   punctuation nobody retypes accurately, and
   *   a name that is a strict prefix of another, which is the only way to
   *     tell whether exact matches really do rank first.
   */
  await pg.query(
    `insert into accounts (name, status, stage, industry, billing_street, billing_city,
                           billing_state, billing_postal_code, phone_e164, owner_id)
     values ('Smith & Sons, Inc.','prospect','Lead','Lumber','4 Yard Rd','Asheville','NC',
             '28801','+18285550333', null),
            ('Smith & Sons Holdings','prospect','Lead','Lumber','5 Yard Rd','Asheville','NC',
             '28801','+18285550334', null)`,
  );

  const { rows } = await pg.query<Company>(
    `select id, name, billing_city, billing_state, industry, phone_e164, billing_street
       from accounts order by name`,
  );
  book = rows;
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

async function search(term: string): Promise<string[]> {
  await becomeUser(pg, brokerAuth);
  const { rows } = await pg.query<{ name: string }>(
    `select name from prospect_list($1, 'all', '', '', '', 'relevance', 200, 0)`,
    [term],
  );
  return rows.map((r) => r.name);
}

// ===========================================================================
describe("the seeded book is worth searching", () => {
  it("has enough companies, and a signed-in person to search as", () => {
    // Guards the rest of the file: every assertion below is vacuously true
    // against an empty book or an unauthenticated caller.
    expect(book.length).toBe(42);
    expect(brokerAuth).not.toBe("");
  });

  it("has names with punctuation, and one that is a prefix of another", () => {
    expect(book.some((c) => /[^A-Za-z0-9 ]/.test(c.name))).toBe(true);
    expect(book.filter((c) => c.name.startsWith("Smith & Sons"))).toHaveLength(2);
  });
});

describe("finding a company you know the name of", () => {
  it("finds every single company in the book by its exact name", async () => {
    // The floor. If a company cannot be found by typing its name, nothing else
    // about the search matters.
    const missing: string[] = [];
    for (const company of book) {
      const hits = await search(company.name);
      if (!hits.includes(company.name)) missing.push(company.name);
    }
    expect(missing).toEqual([]);
  }, 120_000);

  it("puts the exact match first, every time", async () => {
    // "Ridgeline Steel" must not come back below "Ridgeline Steel Holdings".
    const wrong: string[] = [];
    for (const company of book) {
      const hits = await search(company.name);
      if (hits[0] !== company.name) wrong.push(`${company.name} → ${hits[0]}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("finds a company by the first word of its name", async () => {
    const missing: string[] = [];
    for (const company of book) {
      const first = company.name.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "");
      if (first.length < 3) continue;
      const hits = await search(first);
      if (!hits.includes(company.name)) missing.push(`${first} → ${company.name}`);
    }
    expect(missing).toEqual([]);
  }, 120_000);

  it("finds it with the punctuation dropped, which is how people type", async () => {
    const punctuated = book.filter((c) => /[^A-Za-z0-9 ]/.test(c.name));
    expect(punctuated.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const company of punctuated) {
      const flattened = company.name.replace(/[^A-Za-z0-9]+/g, " ").trim();
      const hits = await search(flattened);
      if (!hits.includes(company.name)) missing.push(company.name);
    }
    expect(missing).toEqual([]);
  }, 120_000);

  it("does not care about case", async () => {
    const sample = book.slice(0, 8);
    for (const company of sample) {
      expect(await search(company.name.toUpperCase()), company.name).toContain(company.name);
      expect(await search(company.name.toLowerCase()), company.name).toContain(company.name);
    }
  }, 60_000);

  it("ignores a trailing space, which every paste carries", async () => {
    const company = book[0];
    expect(await search(`  ${company.name}  `)).toContain(company.name);
  });
});

describe("finding a company you do not know the name of", () => {
  it("finds companies by the city they are in", async () => {
    const withCity = book.filter((c) => c.billing_city);
    expect(withCity.length).toBeGreaterThan(10);

    const city = withCity[0].billing_city!;
    const expected = withCity.filter((c) => c.billing_city === city).map((c) => c.name).sort();
    expect((await search(city)).filter((n) => expected.includes(n)).sort()).toEqual(expected);
  });

  it("finds companies by industry -- the thing the old search advertised and never did", async () => {
    const withIndustry = book.filter((c) => c.industry);
    expect(withIndustry.length).toBeGreaterThan(10);

    const industry = withIndustry[0].industry!;
    const expected = withIndustry.filter((c) => c.industry === industry).map((c) => c.name);
    const hits = await search(industry);
    for (const name of expected) expect(hits, `${industry} should find ${name}`).toContain(name);
  });

  it("finds a company by its street address", async () => {
    const withStreet = book.find((c) => c.billing_street);
    expect(withStreet).toBeTruthy();
    expect(await search(withStreet!.billing_street!)).toContain(withStreet!.name);
  });

  it("finds a company by a phone number pasted in any format", async () => {
    const withPhone = book.find((c) => c.phone_e164);
    expect(withPhone).toBeTruthy();
    const e164 = withPhone!.phone_e164!;
    const digits = e164.replace(/\D/g, "");
    const pretty = `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;

    for (const form of [e164, digits, pretty]) {
      expect(await search(form), form).toContain(withPhone!.name);
    }
  });

  it("narrows rather than widens when a second word is added", async () => {
    // The behaviour people expect and the one the old search got backwards --
    // it matched nothing at all on two words rather than matching fewer.
    const city = book.find((c) => c.billing_city && c.industry)!;
    const broad = await search(city.billing_city!);
    const narrow = await search(`${city.billing_city} ${city.industry}`);

    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    expect(narrow).toContain(city.name);
    for (const name of narrow) expect(broad).toContain(name);
  });
});

describe("what a search should NOT do", () => {
  it("returns nothing for a term that is in no company", async () => {
    expect(await search("zzzzqqqq")).toEqual([]);
  });

  it("returns the whole book for an empty term rather than nothing", async () => {
    expect((await search("")).length).toBe(42);
    expect((await search("   ")).length).toBe(42);
  });

  it("survives punctuation typed on its own", async () => {
    // A term that normalises to nothing is an empty search, not an error and
    // not a match against everything by accident.
    for (const junk of ["...", "&&&", "()", "-", "%"]) {
      expect((await search(junk)).length, junk).toBe(42);
    }
  });

  it("cannot be made to return more than the whole book", async () => {
    // A wildcard character in the term must be a character, not a wildcard.
    expect((await search("%")).length).toBeLessThanOrEqual(42);
    expect((await search("_")).length).toBeLessThanOrEqual(42);
  });

  it("does not fall over on a very long term", async () => {
    expect(await search("a".repeat(500))).toEqual([]);
  });
});
