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

// --- Flavour: a marketing agency and the local businesses it sells to -------

const NAME_PREFIXES = [
  "Cardinal", "Bluewater", "Summit", "Ironwood", "Northgate", "Riverbend",
  "Copperfield", "Stonebridge", "Harborview", "Redwood", "Silverline",
  "Brightpath", "Greenfield", "Lakeshore", "Foxglove", "Meridian", "Anchor",
  "Trailhead", "Pinnacle", "Westfield", "Camden", "Halcyon", "Kestrel",
  "Juniper", "Fairmont", "Oakhurst", "Beacon", "Windrow", "Marbury", "Thistle",
  "Colton", "Everly", "Granite", "Hollowbrook", "Larkspur", "Middleton",
  "Norwood", "Pemberton", "Quarry", "Rockvale", "Saltwater", "Tanglewood",
];

const INDUSTRIES = [
  { name: "Home Services", suffixes: ["Roofing", "HVAC", "Plumbing", "Exteriors", "Landscaping"] },
  { name: "Healthcare", suffixes: ["Dental", "Orthodontics", "Family Medicine", "Dermatology"] },
  { name: "Legal", suffixes: ["Law Group", "Legal Partners", "Injury Attorneys"] },
  { name: "Restaurants", suffixes: ["Grill", "Kitchen", "Hospitality Group", "Taproom"] },
  { name: "Fitness & Wellness", suffixes: ["Fitness", "Athletic Club", "Wellness Studio"] },
  { name: "Automotive", suffixes: ["Auto Group", "Motors", "Collision Center"] },
  { name: "Real Estate", suffixes: ["Realty", "Properties", "Home Partners"] },
  { name: "E-commerce", suffixes: ["Outfitters", "Supply Co", "Goods"] },
  { name: "B2B Services", suffixes: ["Solutions", "Consulting", "Logistics"] },
  { name: "Education", suffixes: ["Academy", "Learning Center", "Tutoring"] },
  { name: "Financial Services", suffixes: ["Financial", "Wealth Partners", "Insurance Group"] },
  { name: "Nonprofit", suffixes: ["Foundation", "Alliance", "Community Fund"] },
];

const TITLES = [
  "Owner", "Marketing Director", "VP Marketing", "Chief Marketing Officer",
  "Office Manager", "Operations Manager", "General Manager", "Practice Manager",
  "Director of Growth", "Marketing Coordinator", "Managing Partner", "President",
];

const STAGES = [
  { name: "Discovery", weight: 25, probability: 0.1 },
  { name: "Proposal", weight: 20, probability: 0.35 },
  { name: "Negotiation", weight: 15, probability: 0.65 },
  { name: "Closed Won", weight: 25, probability: 1 },
  { name: "Closed Lost", weight: 15, probability: 0 },
];

const SERVICES = ["Paid Search", "Paid Social", "SEO", "Email", "Creative", "Full Service"];
const TIERS = ["Starter", "Growth", "Scale", "Enterprise"];
const REFERRAL_SOURCES = ["Inbound", "Referral", "Outbound", "Event", "Partner"];

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
  const userRows: (typeof schema.users.$inferInsert)[] = [];
  let extension = 100;

  const admin = {
    email: "avery.stone@megaforce.test",
    fullName: "Avery Stone",
    role: "admin" as const,
    managerId: null,
    rcExtensionId: String(extension++),
  };
  userRows.push(admin);

  const [adminRow] = await db.insert(schema.users).values(admin).returning({ id: schema.users.id });

  const directorCount = 2;
  const managerCount = 7;
  const repCount = volumes.users - 1 - directorCount - managerCount;

  const directorIds: string[] = [];
  for (let i = 0; i < directorCount; i++) {
    const full = faker.person.fullName();
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}@megaforce.test`,
        fullName: full,
        role: "manager",
        managerId: adminRow.id,
        rcExtensionId: String(extension++),
      })
      .returning({ id: schema.users.id });
    directorIds.push(row.id);
  }

  const managerIds: string[] = [];
  for (let i = 0; i < managerCount; i++) {
    const full = faker.person.fullName();
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}${i}@megaforce.test`,
        fullName: full,
        role: "manager",
        managerId: directorIds[i % directorIds.length],
        rcExtensionId: String(extension++),
      })
      .returning({ id: schema.users.id });
    managerIds.push(row.id);
  }

  const repIds: string[] = [];
  for (let i = 0; i < repCount; i++) {
    const full = faker.person.fullName();
    const [row] = await db
      .insert(schema.users)
      .values({
        email: `${slug(full)}${i}r@megaforce.test`,
        fullName: full,
        role: "rep",
        managerId: managerIds[i % managerIds.length],
        rcExtensionId: String(extension++),
      })
      .returning({ id: schema.users.id });
    repIds.push(row.id);
  }

  // Accounts belong to reps, plus a handful to managers so the manager rollup
  // has something of its own to show.
  const ownerPool = [...repIds, ...managerIds.slice(0, 3)];

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  log(`creating ${volumes.accounts} accounts`);
  const usedNames = new Set<string>();
  const accountSeeds: {
    name: string;
    ownerId: string;
    industry: string;
    status: string;
    domain: string;
    custom: Record<string, unknown>;
    createdAt: Date;
  }[] = [];

  for (let i = 0; i < volumes.accounts; i++) {
    const industry = faker.helpers.arrayElement(INDUSTRIES);
    let name = "";
    do {
      name = `${faker.helpers.arrayElement(NAME_PREFIXES)} ${faker.helpers.arrayElement(industry.suffixes)}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    const tier = faker.helpers.arrayElement(TIERS);
    accountSeeds.push({
      name,
      ownerId: faker.helpers.arrayElement(ownerPool),
      industry: industry.name,
      status: faker.helpers.weightedArrayElement([
        { value: "active", weight: 78 },
        { value: "prospect", weight: 15 },
        { value: "churned", weight: 7 },
      ]),
      domain: `${slug(name)}.test`,
      custom: {
        monthly_retainer: faker.number.int({ min: 1500, max: 24000 }),
        service_tier: tier,
        renewal_date: faker.date
          .between({ from: "2026-08-01", to: "2027-08-01" })
          .toISOString()
          .slice(0, 10),
        referral_source: faker.helpers.arrayElement(REFERRAL_SOURCES),
        referenceable: faker.datatype.boolean({ probability: 0.3 }),
        primary_channel: faker.helpers.arrayElement(SERVICES),
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
  for (let i = 0; i < accountIds.length; i++) accountOwner.set(accountIds[i], accountSeeds[i].ownerId);

  const oppSeeds: (typeof schema.opportunities.$inferInsert)[] = [];
  for (let i = 0; i < volumes.opportunities; i++) {
    const accountId = faker.helpers.arrayElement(accountIds);
    const stage = weighted(STAGES);
    const service = faker.helpers.arrayElement(SERVICES);
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
    const verdict = qualify({ type, durationSeconds, result, direction }, activeRule);
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
