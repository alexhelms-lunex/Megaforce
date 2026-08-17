/**
 * Synthetic seed data.
 *
 * ===========================================================================
 * EVERY VALUE IN THIS FILE IS INVENTED. No real company, person, phone number,
 * email address, or credit information appears here or may ever be added.
 * Phone numbers use the 555 exchange, which is reserved for fiction. Email
 * domains use .test, which is reserved by RFC 2606 and cannot be registered.
 * ===========================================================================
 *
 * The volumes come from the build plan. The MESS is the point: a seed of clean,
 * well-formed records would let a broken matcher look correct. These are
 * planted deliberately, and each one corresponds to a case the pipeline has to
 * survive:
 *
 *   - contacts with no phone at all
 *   - one phone number appearing at two different accounts  -> ambiguous match
 *   - numbers written with extensions, in mixed formats      -> normalization
 *   - an account with no activity whatsoever                 -> empty states
 *   - the same email address at two different accounts       -> ambiguous match
 *
 * Faker is seeded with a constant, so every run produces the identical
 * database. A demo that shows different numbers each time is a demo you cannot
 * rehearse.
 */
import { faker } from "@faker-js/faker";
import { sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { toE164 } from "../src/lib/phone";
import { qualify, toRule, type Direction } from "../src/lib/qualify";
import type { Db } from "../src/lib/matcher";

export interface SeedVolumes {
  users: number;
  accounts: number;
  contacts: number;
  opportunities: number;
  activities: number;
  days: number;
}

export const DEFAULT_VOLUMES: SeedVolumes = {
  users: 40,
  accounts: 800,
  contacts: 3000,
  opportunities: 1200,
  activities: 20_000,
  days: 180,
};

// --- Flavour: a freight brokerage and the companies whose freight it moves --

const NAME_PREFIXES = [
  "Cardinal", "Bluewater", "Summit", "Ironwood", "Northgate", "Riverbend",
  "Copperfield", "Stonebridge", "Harborview", "Redwood", "Silverline",
  "Brightpath", "Greenfield", "Lakeshore", "Foxglove", "Meridian", "Anchor",
  "Trailhead", "Pinnacle", "Westfield", "Camden", "Halcyon", "Kestrel",
  "Juniper", "Fairmont", "Oakhurst", "Beacon", "Windrow", "Marbury", "Thistle",
  "Colton", "Everly", "Granite", "Hollowbrook", "Larkspur", "Middleton",
  "Norwood", "Pemberton", "Quarry", "Rockvale", "Saltwater", "Tanglewood",
];

/**
 * Industries, using the exact values from the controlled list in 0009.
 *
 * Free-text industries were the earlier version of this and they were wrong:
 * an import that writes "Food-Dry" next to "Food - Dry" splits every report
 * that groups by industry, and the damage is invisible until somebody adds the
 * two rows together by hand.
 */
const INDUSTRIES = [
  { name: "Food - Dry", suffixes: ["Foods", "Provisions", "Pantry Co"] },
  { name: "Food - Frozen", suffixes: ["Cold Storage", "Frozen Foods", "Creamery"] },
  { name: "Food Ingredients", suffixes: ["Ingredients", "Flavor Co", "Blending"] },
  { name: "Beverages - non-alcoholic", suffixes: ["Beverage Co", "Bottling", "Distributing"] },
  { name: "Beverages - alcoholic", suffixes: ["Brewing", "Cellars", "Distillery"] },
  { name: "Building Materials", suffixes: ["Supply Co", "Building Products", "Concrete"] },
  { name: "Lumber", suffixes: ["Lumber", "Timber Co", "Sawmill"] },
  { name: "Industrial Supplies", suffixes: ["Manufacturing", "Industries", "Fabrication", "Works"] },
  { name: "Consumer Packaged Goods", suffixes: ["Brands", "Housewares", "Goods"] },
  { name: "Chemicals", suffixes: ["Chemical", "Coatings", "Solvents"] },
  { name: "Plastics", suffixes: ["Polymers", "Plastics", "Molding"] },
  { name: "Paper Products", suffixes: ["Packaging", "Paper Co", "Container Corp"] },
  { name: "Auto and Auto Parts", suffixes: ["Auto Parts", "Components", "Driveline"] },
  { name: "Nuts/Grains", suffixes: ["Grain", "Agri Supply", "Milling"] },
  { name: "Produce", suffixes: ["Produce Co", "Growers", "Orchards"] },
  { name: "Meat/Poultry", suffixes: ["Meats", "Poultry Co", "Packing"] },
  { name: "Dairy", suffixes: ["Dairy", "Cheese Co"] },
  { name: "Metal", suffixes: ["Steel", "Metals", "Alloy Co"] },
  { name: "Furniture", suffixes: ["Furniture", "Millwork", "Casegoods"] },
  { name: "Grocery/Retail", suffixes: ["Markets", "Grocers", "Outfitters"] },
  { name: "Medical", suffixes: ["Medical", "Surgical Supply"] },
  { name: "Lawn and Garden", suffixes: ["Nursery", "Garden Co", "Turf Supply"] },
  { name: "Recycling", suffixes: ["Recycling", "Fiber Co", "Salvage"] },
  { name: "Beauty Products", suffixes: ["Beauty", "Cosmetics Co"] },
];

/**
 * Where the fictional customers ship from, and where the branches sit.
 *
 * Real cities with real coordinates -- geography is public fact, and the map
 * has to point somewhere plausible. The companies, people, phone numbers and
 * credit lines placed at these coordinates are all invented.
 */
const METROS = [
  { city: "Charlotte", state: "NC", zips: ["28202", "28208", "28217"], lat: 35.2271, lng: -80.8431 },
  { city: "Atlanta", state: "GA", zips: ["30318", "30336", "30354"], lat: 33.749, lng: -84.388 },
  { city: "Dallas", state: "TX", zips: ["75207", "75212", "75247"], lat: 32.7767, lng: -96.797 },
  { city: "Fort Worth", state: "TX", zips: ["76106", "76137"], lat: 32.7555, lng: -97.3308 },
  { city: "Chicago", state: "IL", zips: ["60632", "60638", "60609"], lat: 41.8781, lng: -87.6298 },
  { city: "Joliet", state: "IL", zips: ["60431", "60436"], lat: 41.525, lng: -88.0817 },
  { city: "Memphis", state: "TN", zips: ["38118", "38116"], lat: 35.1495, lng: -90.049 },
  { city: "Nashville", state: "TN", zips: ["37210", "37217"], lat: 36.1627, lng: -86.7816 },
  { city: "Indianapolis", state: "IN", zips: ["46241", "46231"], lat: 39.7684, lng: -86.1581 },
  { city: "Columbus", state: "OH", zips: ["43217", "43228"], lat: 39.9612, lng: -82.9988 },
  { city: "Harrisburg", state: "PA", zips: ["17110", "17111"], lat: 40.2732, lng: -76.8867 },
  { city: "Allentown", state: "PA", zips: ["18109", "18106"], lat: 40.6084, lng: -75.4902 },
  { city: "Savannah", state: "GA", zips: ["31408", "31415"], lat: 32.0809, lng: -81.0912 },
  { city: "Jacksonville", state: "FL", zips: ["32218", "32254"], lat: 30.3322, lng: -81.6557 },
  { city: "Lakeland", state: "FL", zips: ["33805", "33815"], lat: 28.0395, lng: -81.9498 },
  { city: "Laredo", state: "TX", zips: ["78045", "78041"], lat: 27.5306, lng: -99.4803 },
  { city: "Houston", state: "TX", zips: ["77032", "77015"], lat: 29.7604, lng: -95.3698 },
  { city: "Kansas City", state: "MO", zips: ["64120", "64161"], lat: 39.0997, lng: -94.5786 },
  { city: "Omaha", state: "NE", zips: ["68110", "68127"], lat: 41.2565, lng: -95.9345 },
  { city: "Denver", state: "CO", zips: ["80216", "80239"], lat: 39.7392, lng: -104.9903 },
  { city: "Salt Lake City", state: "UT", zips: ["84104", "84116"], lat: 40.7608, lng: -111.891 },
  { city: "Phoenix", state: "AZ", zips: ["85043", "85009"], lat: 33.4484, lng: -112.074 },
  { city: "Ontario", state: "CA", zips: ["91761", "91764"], lat: 34.0633, lng: -117.6509 },
  { city: "Stockton", state: "CA", zips: ["95206", "95215"], lat: 37.9577, lng: -121.2908 },
  { city: "Portland", state: "OR", zips: ["97218", "97203"], lat: 45.5152, lng: -122.6784 },
  { city: "Tacoma", state: "WA", zips: ["98421", "98424"], lat: 47.2529, lng: -122.4443 },
  { city: "Greenville", state: "SC", zips: ["29605", "29611"], lat: 34.8526, lng: -82.394 },
  { city: "Richmond", state: "VA", zips: ["23234", "23231"], lat: 37.5407, lng: -77.436 },
  { city: "Edison", state: "NJ", zips: ["08817", "08837"], lat: 40.5187, lng: -74.4121 },
  { city: "Grand Rapids", state: "MI", zips: ["49512", "49548"], lat: 42.9634, lng: -85.6681 },
];

const STREET_NAMES = [
  "Distribution", "Commerce", "Industrial", "Logistics", "Freight", "Terminal",
  "Corporate", "Enterprise", "Gateway", "Crossdock", "Warehouse", "Frontage",
];
const STREET_TYPES = ["Drive", "Parkway", "Boulevard", "Court", "Way", "Road", "Lane"];

/** The branches the sales floor works out of. */
const BRANCHES = [
  "Charlotte, NC",
  "Atlanta, GA",
  "Dallas, TX",
  "Chicago, IL",
  "Nashville, TN",
  "Phoenix, AZ",
  "Tampa, FL",
  "Denver, CO",
];

/** The approved sales-contact types from the prospecting policy. */
const CONTACT_TYPES = [
  "Owner", "C Suite Level", "Director of Supply Chain / Logistics", "Procurement",
  "Carrier Relations", "4PL Logistics Manager", "Logistics Manager",
  "Logistics Coordinator", "Logistics Operations", "Sales", "Buyer / Purchasing", "Other",
];

const TITLES = [
  "Logistics Manager", "Transportation Manager", "VP Supply Chain", "Shipping Manager",
  "Director of Logistics", "Traffic Manager", "Warehouse Manager", "Operations Manager",
  "Supply Chain Analyst", "Procurement Manager", "Plant Manager", "Owner",
];

const STAGES = [
  { name: "Discovery", weight: 25, probability: 0.1 },
  { name: "Proposal", weight: 20, probability: 0.35 },
  { name: "Negotiation", weight: 15, probability: 0.65 },
  { name: "Closed Won", weight: 25, probability: 1 },
  { name: "Closed Lost", weight: 15, probability: 0 },
];

const MODES = ["Dry Van", "Reefer", "Flatbed", "LTL", "Intermodal", "Expedited"];
const VOLUME_BANDS = ["1-5 loads/wk", "5-20 loads/wk", "20-50 loads/wk", "50+ loads/wk"];
const LEAD_SOURCES = ["Cold Call", "Inbound", "Referral", "Trade Show", "Salesforce Import", "List Purchase"];

/** Area codes used by the fictional client base. */
const AREA_CODES = ["704", "919", "336", "828", "980", "252", "743", "984"];

const CALL_RESULTS: { value: string; weight: number }[] = [
  { value: "Call connected", weight: 42 },
  { value: "Voicemail", weight: 24 },
  { value: "No Answer", weight: 16 },
  { value: "Missed", weight: 10 },
  { value: "Busy", weight: 5 },
  { value: "Rejected", weight: 3 },
];

// --- helpers ---------------------------------------------------------------

function weighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = faker.number.float({ min: 0, max: total });
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * A fictional number, then written back out in a format a human might have
 * typed. The matcher's job is to collapse all of these onto one key, so the
 * seed deliberately supplies all of them.
 */
function fictionalPhone(): string {
  const area = faker.helpers.arrayElement(AREA_CODES);
  // 555-01xx is the block explicitly reserved for fictional use.
  const line = faker.number.int({ min: 100, max: 199 });
  return `+1${area}555${String(line).padStart(4, "0")}`;
}

/** Re-render an E.164 number the way a person or an import file might have. */
function messyFormat(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (!m) return e164;
  const [, a, b, c] = m;
  switch (faker.number.int({ min: 0, max: 6 })) {
    case 0: return e164;
    case 1: return `(${a}) ${b}-${c}`;
    case 2: return `${a}-${b}-${c}`;
    case 3: return `${a}.${b}.${c}`;
    case 4: return `${a}${b}${c}`;
    case 5: return `${a}-${b}-${c} x${faker.number.int({ min: 10, max: 499 })}`;
    default: return `+1 (${a}) ${b}-${c} ext. ${faker.number.int({ min: 100, max: 900 })}`;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 22);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A shipping address in one of the freight metros, jittered off the city
 * centre so the pins do not all stack on one point.
 *
 * Roughly six hundredths of a degree is four or five miles -- enough to spread
 * across an industrial belt, tight enough that the metro is still recognisable.
 */
function addressIn(metro: (typeof METROS)[number]) {
  return {
    billingStreet: `${faker.number.int({ min: 100, max: 9800 })} ${faker.helpers.arrayElement(
      STREET_NAMES,
    )} ${faker.helpers.arrayElement(STREET_TYPES)}${
      faker.datatype.boolean({ probability: 0.18 })
        ? `, Suite ${faker.number.int({ min: 100, max: 850 })}`
        : ""
    }`,
    billingCity: metro.city,
    billingState: metro.state,
    billingPostalCode: faker.helpers.arrayElement(metro.zips),
    billingCountry: "United States",
    billingLatitude: (metro.lat + faker.number.float({ min: -0.06, max: 0.06 })).toFixed(6),
    billingLongitude: (metro.lng + faker.number.float({ min: -0.06, max: 0.06 })).toFixed(6),
  };
}

/**
 * How many prospects a rep may hold, from the prospecting policy's tiers.
 *
 * Junior (0-12 months) is 200 and Unseasoned (2-3 years) is 100. That reads
 * like a mistake and is not: a new broker is building a book from nothing and
 * needs the width, while a rep two years in is expected to be converting what
 * they already hold. Confirmed against the policy -- do not "fix" it.
 */
function prospectLimitFor(role: string, startDate: Date): number {
  if (role === "manager") return 250; // National Account Directors
  const months = (Date.now() - startDate.getTime()) / (30.44 * 86_400_000);
  if (months < 12) return 200; // Junior
  if (months < 36) return 100; // Unseasoned
  return 100; // Veteran: 15 per customer setup, capped at 100
}

export interface SeedReport {
  users: number;
  accounts: number;
  contacts: number;
  opportunities: number;
  activities: number;
  qualifyingActivities: number;
  /** Named landmarks a demo can navigate to directly. */
  landmarks: Record<string, string>;
}

// ---------------------------------------------------------------------------

export async function seed(
  db: Db,
  volumes: SeedVolumes = DEFAULT_VOLUMES,
  log: (msg: string) => void = () => {},
): Promise<SeedReport> {
  faker.seed(20260729);

  log("clearing existing data");
  // Children before parents; unmatched_activities points at activities once an
  // item has been resolved. Issued one at a time because the drivers differ on
  // multi-statement support, and TRUNCATE ... CASCADE would reach through the
  // users foreign key and empty qualification_rules with it.
  for (const table of [
    "account_claims",
    "unmatched_activities",
    "activities",
    "raw_events",
    "contacts",
    "opportunities",
    "saved_views",
    "accounts",
    "users",
  ]) {
    await db.execute(sql.raw(`delete from ${table}`));
  }

  // -------------------------------------------------------------------------
  // Users, arranged into an org chart.
  //
  // The shape matters more than the count: row level security walks manager_id
  // recursively, so a flat list of users would leave the manager rules
  // completely untested by the demo.
  // -------------------------------------------------------------------------
  log(`creating ${volumes.users} users`);
  let extension = 100;

  /**
   * Start dates are spread across six years so the policy's tiers are all
   * represented -- a book where every rep is a veteran never exercises the
   * junior limit, and the limit is the interesting part.
   */
  const startFor = (yearsAgoMax: number) =>
    faker.date.between({
      from: new Date(Date.now() - yearsAgoMax * 365 * 86_400_000),
      to: new Date(Date.now() - 30 * 86_400_000),
    });

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const adminStart = startFor(8);
  const [adminRow] = await db
    .insert(schema.users)
    .values({
      email: "avery.stone@megaforce.test",
      fullName: "Avery Stone",
      role: "admin",
      managerId: null,
      rcExtensionId: String(extension++),
      location: BRANCHES[0],
      startDate: iso(adminStart),
      prospectLimit: null,
    })
    .returning({ id: schema.users.id });

  const directorCount = 2;
  const managerCount = 7;
  const creditCount = 3;
  const repCount = volumes.users - 1 - directorCount - managerCount - creditCount;

  const directorIds: string[] = [];
  for (let i = 0; i < directorCount; i++) {
    const full = faker.person.fullName();
    const start = startFor(9);
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}@megaforce.test`,
        fullName: full,
        role: "manager",
        managerId: adminRow.id,
        rcExtensionId: String(extension++),
        location: BRANCHES[i % BRANCHES.length],
        startDate: iso(start),
        prospectLimit: prospectLimitFor("manager", start),
      })
      .returning({ id: schema.users.id });
    directorIds.push(row.id);
  }

  const managerIds: string[] = [];
  for (let i = 0; i < managerCount; i++) {
    const full = faker.person.fullName();
    const start = startFor(7);
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}${i}@megaforce.test`,
        fullName: full,
        role: "manager",
        managerId: directorIds[i % directorIds.length],
        rcExtensionId: String(extension++),
        location: BRANCHES[i % BRANCHES.length],
        startDate: iso(start),
        prospectLimit: prospectLimitFor("manager", start),
      })
      .returning({ id: schema.users.id });
    managerIds.push(row.id);
  }

  const repIds: string[] = [];
  const repBranch = new Map<string, string>();
  for (let i = 0; i < repCount; i++) {
    const full = faker.person.fullName();
    // Weighted young: a real floor has more juniors than veterans, and it is
    // the juniors whose limits and clocks matter most.
    const start = startFor(faker.helpers.weightedArrayElement([
      { value: 1, weight: 30 },
      { value: 3, weight: 40 },
      { value: 6, weight: 30 },
    ]));
    const branch = BRANCHES[i % BRANCHES.length];
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}${i}r@megaforce.test`,
        fullName: full,
        role: "broker",
        managerId: managerIds[i % managerIds.length],
        rcExtensionId: String(extension++),
        location: branch,
        startDate: iso(start),
        prospectLimit: prospectLimitFor("broker", start),
      })
      .returning({ id: schema.users.id });
    repIds.push(row.id);
    repBranch.set(row.id, branch);
  }

  /*
   * Account Directors.
   *
   * A distinct role, not a senior broker. They open national accounts and
   * co-own them: a broker runs the account day to day and the AD takes a share,
   * which is why accounts carry ad_owner_id separately from owner_id. Seeded so
   * the role is visible on the People screen and so the co-ownership policy has
   * something real to be tested against.
   */
  const adIds: string[] = [];
  for (let i = 0; i < Math.max(2, Math.round(repCount / 12)); i++) {
    const full = faker.person.fullName();
    const start = startFor(72);
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}${i}ad@megaforce.test`,
        fullName: full,
        role: "ad",
        managerId: adminRow.id,
        rcExtensionId: String(extension++),
        location: BRANCHES[i % BRANCHES.length],
        startDate: iso(start),
        prospectLimit: 250,
      })
      .returning({ id: schema.users.id });
    adIds.push(row.id);
  }

  // The credit team. They own no accounts -- credit is not a sales function --
  // but they see every one of them, so the demo needs real people to sign in as.
  for (let i = 0; i < creditCount; i++) {
    const full = faker.person.fullName();
    const start = startFor(6);
    await db.insert(schema.users).values({
      email: `${slug(full)}${i}c@megaforce.test`,
      fullName: full,
      role: "credit",
      managerId: adminRow.id,
      rcExtensionId: String(extension++),
      location: BRANCHES[0],
      startDate: iso(start),
      prospectLimit: null,
    });
  }

  // Accounts belong to brokers, plus a handful to managers so the manager
  // rollup has something of its own to show.
  const ownerPool = [...repIds, ...managerIds.slice(0, 3)];

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  log(`creating ${volumes.accounts} accounts`);
  const usedNames = new Set<string>();
  const accountSeeds: (typeof schema.accounts.$inferInsert)[] = [];

  for (let i = 0; i < volumes.accounts; i++) {
    const industry = faker.helpers.arrayElement(INDUSTRIES);
    let name = "";
    do {
      name = `${faker.helpers.arrayElement(NAME_PREFIXES)} ${faker.helpers.arrayElement(industry.suffixes)}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    const status = faker.helpers.weightedArrayElement([
      { value: "prospect", weight: 62 },
      { value: "engaged", weight: 24 },
      // Converted. Salesforce owns the relationship from here; this CRM only
      // keeps the record so the broker stays credited.
      { value: "customer", weight: 11 },
      { value: "do_not_contact", weight: 3 },
    ]);

    const metro = faker.helpers.arrayElement(METROS);
    const tier = faker.helpers.arrayElement(VOLUME_BANDS);
    const domain = `${slug(name)}.test`;

    // Credit exists on customers, is sometimes pending on engaged accounts, and
    // never on a cold prospect -- a credit line is something you apply for once
    // there is freight to move.
    const creditStatus =
      status === "customer"
        ? faker.helpers.weightedArrayElement([
            { value: "approved", weight: 78 },
            { value: "on_hold", weight: 13 },
            { value: "revoked", weight: 9 },
          ])
        : status === "engaged" && faker.datatype.boolean({ probability: 0.3 })
          ? "requested"
          : null;

    accountSeeds.push({
      name,
      ownerId: faker.helpers.arrayElement(ownerPool),
      industry: industry.name,
      status,
      domain,
      website: `www.${domain}`,
      // ~8% of companies have no switchboard on file, which is normal and is
      // exactly the record a broker has to work harder to reach.
      phoneE164: faker.datatype.boolean({ probability: 0.92 }) ? fictionalPhone() : null,
      ...addressIn(metro),
      stage: faker.helpers.weightedArrayElement([
        { value: "Lead", weight: 38 },
        { value: "Contact", weight: 27 },
        { value: "Pitch", weight: 18 },
        { value: "Quote", weight: 11 },
        { value: "Closed", weight: 6 },
      ]),
      creditStatus,
      creditLimit: creditStatus
        ? String(faker.number.int({ min: 10, max: 500 }) * 1000)
        : null,
      // National status is proposed by sales and approved by somebody else, so
      // a few sit in review rather than every flag being settled.
      nationalAccount: status === "customer" && faker.datatype.boolean({ probability: 0.09 }),
      nationalAccountInReview:
        status !== "prospect" && faker.datatype.boolean({ probability: 0.03 }),
      custom: {
        annual_freight_spend: faker.number.int({ min: 80, max: 9000 }) * 1000,
        volume_band: tier,
        primary_mode: faker.helpers.arrayElement(MODES),
        lead_source: faker.helpers.arrayElement(LEAD_SOURCES),
        shipping_from: `${metro.city}, ${metro.state}`,
        salesforce_id: faker.datatype.boolean({ probability: 0.35 })
          ? `001${faker.string.alphanumeric({ length: 15, casing: "mixed" })}`
          : null,
      },
      createdAt: faker.date.between({ from: "2024-01-01", to: "2026-06-01" }),
    });
  }

  const accountIds: string[] = [];
  const accountNames = new Map<string, string>();
  for (const batch of chunk(accountSeeds, 400)) {
    const rows = await db
      .insert(schema.accounts)
      .values(batch)
      .returning({ id: schema.accounts.id, name: schema.accounts.name });
    for (const r of rows) {
      accountIds.push(r.id);
      accountNames.set(r.id, r.name);
    }
  }

  const landmarks: Record<string, string> = {};

  // -------------------------------------------------------------------------
  // Corporate hierarchy
  //
  // Freight customers are rarely one company. A location account sits above a
  // handful of service accounts, and credit rolls up the tree while ownership
  // does not -- each account is claimed and worked on its own. Without a few of
  // these in the data, the hierarchy tab and the credit rollup are untested.
  //
  // Children are drawn only from accounts that are not themselves parents, so
  // the tree stays two deep and no cycle is possible.
  // -------------------------------------------------------------------------
  log("building the corporate hierarchy");
  const parentCount = Math.max(1, Math.floor(accountIds.length / 25));
  const parentIds = accountIds.slice(0, parentCount);
  const childPool = accountIds.slice(parentCount);
  let childCursor = 0;

  for (const parentId of parentIds) {
    const howMany = faker.number.int({ min: 1, max: 4 });
    const takes = childPool.slice(childCursor, childCursor + howMany);
    childCursor += howMany;
    if (takes.length === 0) break;
    await db.execute(sql`
      update accounts set parent_account_id = ${parentId}
       where id in (${sql.join(takes.map((id) => sql`${id}`), sql`, `)})
    `);
  }
  landmarks.parentAccount = accountNames.get(parentIds[0]) ?? "";

  // -------------------------------------------------------------------------
  // Account Directors, and national approval
  //
  // A prospect has exactly one owner. A customer can carry two: if an AD set it
  // up, a broker runs it day to day and the AD takes a share of the commission.
  // The database enforces "customers only" with a CHECK, so this update is
  // deliberately scoped to them.
  // -------------------------------------------------------------------------
  // Pointed at people whose ROLE is 'ad'. It used to point at managers, because
  // there was no Account Director role to point at -- so the co-ownership
  // column and the job it represents disagreed in every seeded database.
  await db.execute(sql`
    update accounts set ad_owner_id = ${adIds[0]}
     where status = 'customer' and md5(id::text) < '4'
  `);
  await db.execute(sql`
    update accounts set ad_owner_id = ${adIds[1] ?? adIds[0]}
     where status = 'customer' and ad_owner_id is null and md5(id::text) < '6'
  `);

  // An approved national account has somebody's name against the approval. A
  // flag with nobody behind it is the kind of field that quietly becomes
  // meaningless.
  await db.execute(sql`
    update accounts
       set national_account_approved_by = ${adminRow.id},
           national_account_approved_at = now() - (random() * 400 || ' days')::interval
     where national_account
  `);

  // -------------------------------------------------------------------------
  // Contacts, including the planted mess
  // -------------------------------------------------------------------------
  log(`creating ${volumes.contacts} contacts`);
  const contactSeeds: (typeof schema.contacts.$inferInsert)[] = [];
  const phoneByAccount = new Map<string, string>();

  for (let i = 0; i < volumes.contacts; i++) {
    const accountId = accountIds[i % accountIds.length];
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    const domain = `${slug(accountNames.get(accountId) ?? "client")}.test`;

    // ~15% of contacts have no phone. Real CRMs are full of these, and a call
    // can never match them -- which is exactly what the review queue is for.
    const hasPhone = faker.datatype.boolean({ probability: 0.85 });
    const rawPhone = hasPhone ? messyFormat(fictionalPhone()) : null;

    // Normalized on WRITE. This is the rule the whole matcher depends on.
    const phoneE164 = toE164(rawPhone);
    if (phoneE164 && !phoneByAccount.has(accountId)) phoneByAccount.set(accountId, phoneE164);

    contactSeeds.push({
      accountId,
      firstName: first,
      lastName: last,
      email: faker.datatype.boolean({ probability: 0.93 })
        ? `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`
        : null,
      phoneE164,
      title: faker.helpers.arrayElement(TITLES),
      type: faker.helpers.arrayElement(CONTACT_TYPES),
      custom: {
        decision_maker: faker.datatype.boolean({ probability: 0.35 }),
        preferred_channel: faker.helpers.arrayElement(["Email", "Phone", "Text"]),
      },
    });
  }

  /**
   * Pick two distinct accounts for a planted duplicate.
   *
   * Positions are a FRACTION of the account count, not fixed offsets. Fixed
   * offsets work at the default volume and run off the end of a --small seed,
   * which is exactly the sort of bug that only surfaces the morning of a demo.
   */
  const pairAt = (index: number, startFraction: number): [string, string] | null => {
    const n = accountIds.length;
    if (n < 4) return null;
    const start = Math.floor(n * startFraction);
    const a = accountIds[(start + index * 2) % n];
    const b = accountIds[(start + index * 2 + 1) % n];
    return a === b ? null : [a, b];
  };

  // Scale the number of planted duplicates to the size of the dataset, so a
  // small seed stays proportionate rather than being mostly edge cases.
  const plantedPairs = Math.max(1, Math.min(12, Math.floor(accountIds.length / 8)));

  // --- Planted case: one number at two different accounts -----------------
  // A shared answering service, a reused mobile, a data-entry mistake. The
  // matcher must refuse to pick one and must file it for review instead.
  for (let i = 0; i < plantedPairs; i++) {
    const pair = pairAt(i, 0.125);
    if (!pair) break;
    const [a, b] = pair;
    const shared = fictionalPhone();
    contactSeeds.push(
      {
        accountId: a,
        firstName: "Jordan",
        lastName: faker.person.lastName(),
        email: `frontdesk@${slug(accountNames.get(a) ?? "a")}.test`,
        phoneE164: toE164(shared),
        title: "Office Manager",
        custom: { decision_maker: false, note: "shared answering service" },
      },
      {
        accountId: b,
        firstName: "Riley",
        lastName: faker.person.lastName(),
        email: `frontdesk@${slug(accountNames.get(b) ?? "b")}.test`,
        phoneE164: toE164(shared),
        title: "Office Manager",
        custom: { decision_maker: false, note: "shared answering service" },
      },
    );
    if (i === 0) {
      landmarks.ambiguousPhone = shared;
      landmarks.ambiguousAccountA = accountNames.get(a) ?? "";
      landmarks.ambiguousAccountB = accountNames.get(b) ?? "";
    }
  }

  // --- Planted case: the same email at two different accounts -------------
  for (let i = 0; i < plantedPairs; i++) {
    const pair = pairAt(i, 0.375);
    if (!pair) break;
    const [a, b] = pair;
    const sharedEmail = `hello${i}@sharedinbox.test`;
    contactSeeds.push(
      {
        accountId: a,
        firstName: "Sam",
        lastName: faker.person.lastName(),
        email: sharedEmail,
        phoneE164: toE164(fictionalPhone()),
        title: "Marketing Coordinator",
        custom: {},
      },
      {
        accountId: b,
        firstName: "Alex",
        lastName: faker.person.lastName(),
        email: sharedEmail,
        phoneE164: toE164(fictionalPhone()),
        title: "Marketing Coordinator",
        custom: {},
      },
    );
    if (i === 0) landmarks.duplicateEmail = sharedEmail;
  }

  for (const batch of chunk(contactSeeds, 500)) {
    await db.insert(schema.contacts).values(batch);
  }

  // -------------------------------------------------------------------------
  // Opportunities
  // -------------------------------------------------------------------------
  log(`creating ${volumes.opportunities} opportunities`);
  const accountOwner = new Map<string, string>();
  for (let i = 0; i < accountIds.length; i++) {
    const owner = accountSeeds[i].ownerId;
    if (owner) accountOwner.set(accountIds[i], owner);
  }

  const oppSeeds: (typeof schema.opportunities.$inferInsert)[] = [];
  for (let i = 0; i < volumes.opportunities; i++) {
    const accountId = faker.helpers.arrayElement(accountIds);
    const stage = weighted(STAGES);
    const service = faker.helpers.arrayElement(MODES);
    const months = faker.helpers.arrayElement([6, 12, 12, 18, 24]);
    const monthly = faker.number.int({ min: 2000, max: 22000 });

    oppSeeds.push({
      accountId,
      ownerId: accountOwner.get(accountId)!,
      name: `${accountNames.get(accountId)} - ${service} Retainer`,
      stage: stage.name,
      amount: String(monthly * months),
      closeDate: faker.date
        .between({ from: "2026-01-01", to: "2027-06-30" })
        .toISOString()
        .slice(0, 10),
      custom: {
        retainer_months: months,
        competitor: faker.datatype.boolean({ probability: 0.4 })
          ? `${faker.helpers.arrayElement(NAME_PREFIXES)} Media`
          : null,
        loss_reason:
          stage.name === "Closed Lost"
            ? faker.helpers.arrayElement(["Price", "Timing", "Went In-House", "Chose Competitor", "No Decision"])
            : null,
      },
    });
  }
  for (const batch of chunk(oppSeeds, 400)) {
    await db.insert(schema.opportunities).values(batch);
  }

  // -------------------------------------------------------------------------
  // Activities
  //
  // The insert trigger that maintains accounts.last_activity_at is switched off
  // for the bulk load and the column is recomputed in a single pass afterwards.
  // Leaving it on means 20,000 individual UPDATE statements against accounts,
  // which turns a seconds-long seed into a minutes-long one.
  // -------------------------------------------------------------------------
  log(`creating ${volumes.activities} activities across ${volumes.days} days`);

  const rule = await loadCallRule(db);
  const emailRule = await loadRule(db, "email");
  const meetingRule = await loadRule(db, "meeting");
  const noteRule = await loadRule(db, "note");

  // --- Planted case: accounts with no activity at all ---------------------
  // Empty states are where UIs break, and "no activity in 180 days" is exactly
  // the account a manager wants surfaced. Sized as a share of the dataset so a
  // small seed does not silence every account and leave nothing to talk to.
  const silentCount = Math.max(1, Math.min(40, Math.floor(accountIds.length * 0.05)));
  const silentAccounts = new Set(accountIds.slice(-silentCount));
  landmarks.silentAccount = accountNames.get(accountIds[accountIds.length - 1]) ?? "";

  const activeAccountIds = accountIds.filter((id) => !silentAccounts.has(id));

  const contactsByAccount = new Map<string, { id: string; accountId: string }[]>();
  const allContacts = await db
    .select({ id: schema.contacts.id, accountId: schema.contacts.accountId })
    .from(schema.contacts);
  for (const c of allContacts) {
    const list = contactsByAccount.get(c.accountId) ?? [];
    list.push(c);
    contactsByAccount.set(c.accountId, list);
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - volumes.days * 24 * 3600 * 1000);

  const activitySeeds: (typeof schema.activities.$inferInsert)[] = [];
  let qualifyingCount = 0;

  for (let i = 0; i < volumes.activities; i++) {
    const accountId = faker.helpers.arrayElement(activeAccountIds);
    const contacts = contactsByAccount.get(accountId) ?? [];
    const contact = contacts.length ? faker.helpers.arrayElement(contacts) : null;

    const type = faker.helpers.weightedArrayElement([
      { value: "call" as const, weight: 55 },
      { value: "email" as const, weight: 30 },
      { value: "meeting" as const, weight: 10 },
      { value: "note" as const, weight: 5 },
    ]);
    const direction: Direction =
      type === "note" ? null : faker.helpers.arrayElement(["inbound", "outbound"] as const);
    const occurredAt = faker.date.between({ from: windowStart, to: now });

    let durationSeconds: number | null = null;
    let result: string | null = null;

    if (type === "call") {
      result = weighted(CALL_RESULTS).value;
      // Connected calls run long; everything else is a few seconds of ringing
      // or a voicemail beep. This distribution is what makes the qualification
      // rate look like a real sales floor rather than a coin flip.
      durationSeconds =
        result === "Call connected"
          ? faker.number.int({ min: 25, max: 2400 })
          : faker.number.int({ min: 3, max: 95 });
    } else if (type === "meeting") {
      durationSeconds = faker.number.int({ min: 900, max: 3600 });
    }

    const activeRule =
      type === "call" ? rule : type === "email" ? emailRule : type === "meeting" ? meetingRule : noteRule;

    // The seed runs the SAME qualifier the live pipeline runs. If these two
    // ever disagreed, the demo data would contradict the demo.
    /*
     * Whether the broker wrote the call up.
     *
     * Under the policy a call is not an approved activity until a stage outcome
     * is chosen, so seeding calls without one would leave nothing qualifying
     * and every account showing as overdue. Most connected calls are logged;
     * about one in six is not, because brokers forget -- and those are exactly
     * the rows the RingCentral dock exists to surface.
     */
    const logged =
      type === "call" && result === "Call connected"
        ? faker.datatype.boolean({ probability: 0.84 })
        : type !== "call";

    const stageOutcome =
      type === "call" && logged
        ? faker.helpers.weightedArrayElement([
            { value: "Lead", weight: 34 },
            { value: "Contact", weight: 30 },
            { value: "Pitch", weight: 20 },
            { value: "Quote", weight: 11 },
            { value: "Closed", weight: 5 },
          ])
        : null;

    const verdict = qualify(
      { type, durationSeconds, result, direction, stageOutcome },
      activeRule,
    );
    if (verdict.qualifies) qualifyingCount++;

    activitySeeds.push({
      accountId,
      contactId: contact?.id ?? null,
      userId: accountOwner.get(accountId) ?? null,
      type,
      direction,
      subject: subjectFor(type, direction, accountNames.get(accountId) ?? ""),
      occurredAt,
      durationSeconds,
      result,
      source: type === "call" ? "ringcentral" : type === "email" ? "email" : "manual",
      externalId: type === "call" ? `seed-call-${i}` : type === "email" ? `seed-mail-${i}` : null,
      stageOutcome,
      notes: stageOutcome ? subjectFor("note", direction, accountNames.get(accountId) ?? "") : null,
      loggedBy: stageOutcome ? accountOwner.get(accountId) ?? null : null,
      loggedAt: stageOutcome ? occurredAt : null,
      qualifies: verdict.qualifies,
      qualificationReason: verdict.reason,
    });
  }

  await db.execute(sql`alter table activities disable trigger t_bump_last_activity`);
  try {
    for (const batch of chunk(activitySeeds, 1000)) {
      await db.insert(schema.activities).values(batch);
    }
  } finally {
    await db.execute(sql`alter table activities enable trigger t_bump_last_activity`);
  }

  log("recomputing last_activity_at in a single pass");
  await db.execute(sql`
    update accounts a
       set last_activity_at = s.latest
      from (
        select account_id, max(occurred_at) as latest
          from activities
         where qualifies and account_id is not null
         group by account_id
      ) s
     where a.id = s.account_id
  `);

  // -------------------------------------------------------------------------
  // Lifecycle spread
  //
  // Without this, every account carries whatever last_activity_at the random
  // activity dates happened to produce, and the flags all come out the same
  // colour. A demo needs an account in every state on the first screen, so the
  // distribution is imposed deliberately rather than hoped for.
  //
  // Runs AFTER the recompute above, and overrides it on purpose.
  // -------------------------------------------------------------------------
  log("spreading accounts across the ownership lifecycle");

  // The available pool: roughly one account in eight is unclaimed. Some were
  // never worked, some were lost by a broker who went quiet.
  await db.execute(sql`
    update accounts set
      owner_id = null,
      claimed_at = null,
      released_at = now() - (random() * 30 || ' days')::interval,
      last_release_reason = case when random() < 0.7 then 'expired' else 'manual' end
    where id in (
      select id from accounts where status <> 'customer'
      order by md5(id::text) limit greatest(1, (select count(*) from accounts) / 8)
    )
  `);

  // Close the claim rows those accounts left behind, so the audit trail is
  // consistent with the ownership that actually resulted.
  await db.execute(sql`
    update account_claims c set released_at = now(), release_reason = a.last_release_reason
      from accounts a
     where c.account_id = a.id and a.owner_id is null and c.released_at is null
  `);

  // Push a slice of the still-owned prospects into each warning band. The
  // thresholds are 21 / 30 / 45 days, so these land in amber, red and overdue.
  for (const [band, lo, hi] of [
    ["warning", 15, 20],
    ["expiring", 22, 29],
    ["overdue", 32, 50],
  ] as const) {
    // The day bounds are inlined rather than bound as parameters. Postgres
    // cannot infer a type for `$1 + random() * ($2 - $3)` and refuses with
    // "could not choose a best candidate operator"; these are compile-time
    // constants from the tuple above, so there is nothing to inject.
    await db.execute(sql`
      update accounts set last_activity_at =
        now() - ((${sql.raw(String(lo))} + random() * ${sql.raw(String(hi - lo))}) || ' days')::interval
      where id in (
        select id from accounts
         where owner_id is not null and status = 'prospect'
           and last_activity_at > now() - interval '21 days'
         order by md5(id::text || ${band})
         limit greatest(1, (select count(*) from accounts where owner_id is not null) / 9)
      )
    `);
  }

  // claimed_at has to sit behind last_activity_at, or account_state judges from
  // the claim date and every one of those bands comes back fresh.
  await db.execute(sql`
    update accounts set claimed_at = least(coalesce(claimed_at, now()), coalesce(last_activity_at, now()) - interval '5 days')
    where owner_id is not null
  `);

  /*
   * Now take back everything the bands above pushed past the deadline.
   *
   * This is not tidying -- it is the difference between a demo that lies and
   * one that does not. An owned account showing "26d over" cannot exist in a
   * running system: the sweep takes it within the hour. Seeding a book full of
   * them and leaving them owned reproduced, on every fresh setup, exactly the
   * bug the sweep was written to prevent -- and looked identical to the sweep
   * being broken.
   *
   * The released accounts land in the available pool, which is where a
   * neglected prospect genuinely ends up, so the demo gains a realistic pool
   * rather than losing anything.
   */
  log("releasing everything already past its deadline");
  await db.execute(sql`select release_overdue_accounts()`);

  const spread = await db.execute<{ state: string; c: string }>(sql`
    select account_state(owner_id, status, last_activity_at, claimed_at, retention_override_until) state, count(*)::text c
      from accounts group by 1 order by 1
  `);
  for (const row of (Array.isArray(spread) ? spread : (spread as { rows: { state: string; c: string }[] }).rows)) {
    landmarks[`state_${row.state}`] = `${row.c} accounts`;
  }

  // A saved view worth opening on stage.
  await db.insert(schema.savedViews).values({
    object: "account",
    name: "Going cold (no qualifying activity in 30 days)",
    ownerId: adminRow.id,
    shared: true,
    definition: { staleDays: 30, status: "active", sort: "last_activity_at" },
  });

  return {
    users: volumes.users,
    accounts: volumes.accounts,
    contacts: contactSeeds.length,
    opportunities: volumes.opportunities,
    activities: volumes.activities,
    qualifyingActivities: qualifyingCount,
    landmarks,
  };
}

function subjectFor(type: string, direction: Direction, accountName: string): string {
  switch (type) {
    case "call":
      return direction === "inbound" ? `Inbound call from ${accountName}` : `Outbound call to ${accountName}`;
    case "email":
      return faker.helpers.arrayElement([
        "Campaign performance recap",
        "Q3 creative review",
        "Retainer renewal",
        "Landing page revisions",
        "Monthly reporting",
        "Budget adjustment",
      ]);
    case "meeting":
      return faker.helpers.arrayElement(["Quarterly business review", "Kickoff call", "Strategy session"]);
    default:
      return faker.helpers.arrayElement([
        "Left a note after the call",
        "Contract sent for signature",
        "Referred by an existing client",
      ]);
  }
}

async function loadRule(db: Db, type: "call" | "email" | "meeting" | "note") {
  const rows = await db
    .select()
    .from(schema.qualificationRules)
    .where(sql`${schema.qualificationRules.activityType} = ${type} and ${schema.qualificationRules.active}`)
    .limit(1);
  return rows[0] ? toRule(rows[0]) : null;
}

const loadCallRule = (db: Db) => loadRule(db, "call");
