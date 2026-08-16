/**
 * The account list's query, as data.
 *
 * Filter state lives in the URL and nowhere else. That single decision buys
 * most of what a sales floor actually asks for: a filtered list can be pasted
 * into a message, bookmarked, opened in a second tab, and walked backwards with
 * the browser's own back button. Holding it in component state instead would
 * mean rebuilding all four of those, badly.
 *
 * Parsing lives here rather than in the page so the list, the saved views and
 * the CSV export all read a URL the same way. When they disagree, the export
 * quietly contains different rows than the screen it was exported from.
 */

export const PAGE_SIZE = 50;

export type SortKey =
  | "urgency"
  | "name"
  | "recent"
  | "stale"
  | "days_left"
  | "credit"
  | "city";

export interface AccountFilters {
  q: string;
  status: string;
  state: string;
  stage: string;
  industry: string;
  billingState: string;
  city: string;
  owner: string;
  ownerLocation: string;
  creditStatus: string;
  /** '', 'yes', 'no' */
  national: string;
  /** '', 'parents', 'children' */
  hierarchy: string;
  /** '', 'none', '30', '60', '90' -- minimum days since last qualifying activity. */
  idle: string;
  /** '', 'yes', 'no' -- whether the account has any contact on file. */
  hasContacts: string;
  mine: boolean;
  unowned: boolean;
  sort: SortKey;
  page: number;
  preset: string;
}

export const EMPTY: AccountFilters = {
  q: "",
  status: "",
  state: "",
  stage: "",
  industry: "",
  billingState: "",
  city: "",
  owner: "",
  ownerLocation: "",
  creditStatus: "",
  national: "",
  hierarchy: "",
  idle: "",
  hasContacts: "",
  mine: false,
  unowned: false,
  sort: "urgency",
  page: 1,
  preset: "",
};

/**
 * The saved searches every rep needs and nobody wants to rebuild by hand.
 *
 * A preset is just a set of filters, applied first and then overridden by
 * anything else in the URL -- so "at risk" can be narrowed to one industry
 * without leaving the preset.
 */
export interface Preset {
  key: string;
  label: string;
  description: string;
  filters: Partial<AccountFilters>;
}

export const PRESETS: Preset[] = [
  {
    key: "my-book",
    label: "My book",
    description: "Everything you currently hold.",
    filters: { mine: true, sort: "urgency" },
  },
  {
    key: "at-risk",
    label: "At risk",
    description: "Past day 21 and heading for release.",
    filters: { mine: true, state: "at-risk", sort: "days_left" },
  },
  {
    key: "expiring",
    label: "Expiring",
    description: "Days away from returning to the pool.",
    filters: { mine: true, state: "expiring", sort: "days_left" },
  },
  {
    key: "never-worked",
    label: "Never worked",
    description: "Claimed, but no qualifying activity has ever landed.",
    filters: { mine: true, idle: "none", sort: "days_left" },
  },
  {
    key: "my-customers",
    label: "My customers",
    description: "Converted, and still yours.",
    filters: { mine: true, status: "customer", sort: "recent" },
  },
  {
    key: "pool",
    label: "Available pool",
    description: "Unclaimed. Anyone can take these.",
    filters: { unowned: true, sort: "recent" },
  },
  {
    key: "national",
    label: "National accounts",
    description: "Approved national accounts.",
    filters: { national: "yes", sort: "name" },
  },
  {
    key: "all",
    label: "Everything I can see",
    description: "The full visible book, most urgent first.",
    filters: { sort: "urgency" },
  },
];

type Raw = Record<string, string | string[] | undefined>;

function one(raw: Raw, key: string): string {
  const v = raw[key];
  const s = Array.isArray(v) ? v[0] : v;
  return (s ?? "").trim();
}

export function parseFilters(raw: Raw): AccountFilters {
  const presetKey = one(raw, "preset");
  const preset = PRESETS.find((p) => p.key === presetKey);

  const base: AccountFilters = { ...EMPTY, ...(preset?.filters ?? {}), preset: presetKey };

  // Explicit parameters win over the preset's defaults, so a preset is a
  // starting point rather than a cage.
  const pick = (key: string, fallback: string) => (key in raw ? one(raw, key) : fallback);

  const page = Number.parseInt(one(raw, "page") || "1", 10);

  return {
    ...base,
    q: pick("q", base.q),
    status: pick("status", base.status),
    state: pick("state", base.state),
    stage: pick("stage", base.stage),
    industry: pick("industry", base.industry),
    billingState: pick("st", base.billingState),
    city: pick("city", base.city),
    owner: pick("owner", base.owner),
    ownerLocation: pick("loc", base.ownerLocation),
    creditStatus: pick("credit", base.creditStatus),
    national: pick("national", base.national),
    hierarchy: pick("tree", base.hierarchy),
    idle: pick("idle", base.idle),
    hasContacts: pick("contacts", base.hasContacts),
    mine: "mine" in raw ? one(raw, "mine") === "1" : base.mine,
    unowned: "unowned" in raw ? one(raw, "unowned") === "1" : base.unowned,
    sort: (SORTS.some((s) => s.key === pick("sort", base.sort))
      ? pick("sort", base.sort)
      : "urgency") as SortKey,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Back to a query string, dropping everything at its default. */
export function toQueryString(f: Partial<AccountFilters>): string {
  const p = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v) p.set(k, v);
  };
  if (f.preset) put("preset", f.preset);
  put("q", f.q);
  put("status", f.status);
  put("state", f.state);
  put("stage", f.stage);
  put("industry", f.industry);
  put("st", f.billingState);
  put("city", f.city);
  put("owner", f.owner);
  put("loc", f.ownerLocation);
  put("credit", f.creditStatus);
  put("national", f.national);
  put("tree", f.hierarchy);
  put("idle", f.idle);
  put("contacts", f.hasContacts);
  if (f.mine) p.set("mine", "1");
  if (f.unowned) p.set("unowned", "1");
  if (f.sort && f.sort !== "urgency") p.set("sort", f.sort);
  if (f.page && f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

/** How many filters are doing something, for the "clear (3)" affordance. */
export function activeCount(f: AccountFilters): number {
  let n = 0;
  for (const key of [
    "q",
    "status",
    "state",
    "stage",
    "industry",
    "billingState",
    "city",
    "owner",
    "ownerLocation",
    "creditStatus",
    "national",
    "hierarchy",
    "idle",
    "hasContacts",
  ] as const) {
    if (f[key]) n += 1;
  }
  if (f.mine) n += 1;
  if (f.unowned) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Vocabulary shared by the filter bar and the table
// ---------------------------------------------------------------------------

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "urgency", label: "Most urgent" },
  { key: "days_left", label: "Least time left" },
  { key: "stale", label: "Longest since contact" },
  { key: "recent", label: "Recently worked" },
  { key: "name", label: "Company A–Z" },
  { key: "city", label: "City" },
  { key: "credit", label: "Largest credit line" },
];

export const STATUS_OPTIONS = [
  { value: "prospect", label: "Prospect" },
  { value: "engaged", label: "Engaged" },
  { value: "customer", label: "Customer" },
  { value: "do_not_contact", label: "Do not contact" },
];

export const STATE_OPTIONS = [
  { value: "at-risk", label: "At risk (any amber or red)" },
  { value: "overdue", label: "Releasing" },
  { value: "expiring", label: "Expiring" },
  { value: "warning", label: "Needs attention" },
  { value: "fresh", label: "Active" },
  { value: "available", label: "Available" },
];

export const STAGE_OPTIONS = ["Lead", "Contact", "Pitch", "Quote", "Closed"].map((s) => ({
  value: s,
  label: s,
}));

export const IDLE_OPTIONS = [
  { value: "none", label: "Never worked" },
  { value: "30", label: "30+ days quiet" },
  { value: "60", label: "60+ days quiet" },
  { value: "90", label: "90+ days quiet" },
];

export const CREDIT_OPTIONS = [
  { value: "none", label: "No credit" },
  { value: "requested", label: "Requested" },
  { value: "approved", label: "Approved" },
  { value: "on_hold", label: "On hold" },
  { value: "revoked", label: "Revoked" },
];

export const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  engaged: "Engaged",
  customer: "Customer",
  do_not_contact: "Do not contact",
};

/** Every column the list can show, and whether it starts visible. */
export interface ColumnDef {
  key: string;
  label: string;
  defaultOn: boolean;
  numeric?: boolean;
}

export const COLUMNS: ColumnDef[] = [
  { key: "name", label: "Company", defaultOn: true },
  { key: "owner", label: "Owner", defaultOn: true },
  { key: "location", label: "Location", defaultOn: true },
  { key: "industry", label: "Industry", defaultOn: true },
  { key: "status", label: "Status", defaultOn: true },
  { key: "stage", label: "Stage", defaultOn: true },
  { key: "phone", label: "Phone", defaultOn: false },
  { key: "website", label: "Website", defaultOn: false },
  { key: "parent", label: "Parent", defaultOn: false },
  { key: "credit", label: "Credit", defaultOn: false, numeric: true },
  { key: "contacted", label: "Last contact", defaultOn: false },
  { key: "activity", label: "Last counted", defaultOn: true },
  { key: "clock", label: "Clock", defaultOn: true },
];

export function defaultColumns(): string[] {
  return COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);
}
