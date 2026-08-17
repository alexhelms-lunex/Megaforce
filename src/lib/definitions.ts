/**
 * What every number on every screen actually means.
 *
 * ---------------------------------------------------------------------------
 * One registry, not props at each call site. Two reasons, and the second is the
 * important one:
 *
 *   1. The same metric appears on the dashboard, in reports, in the digest and
 *      on a company record. Explained separately, the four explanations drift,
 *      and a rep who reads two of them trusts neither.
 *
 *   2. Writing the definition down forces it to be true. Several of these
 *      sentences could not be written honestly until the underlying rule was
 *      fixed -- "the clock resets when the account changes hands" was aspiration
 *      until it was actually enforced. A definition file is a quiet audit.
 *
 * `formula` is shown in monospace under the prose. It is there for the person
 * who does not want the paragraph, only the arithmetic -- usually a manager
 * checking whether a number can be argued with.
 * ---------------------------------------------------------------------------
 */
export interface Definition {
  title: string;
  body: string;
  formula?: string;
}

const RAW = {
  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------
  clock: {
    title: "The clock",
    body:
      "How long you keep an account before it returns to the pool. It counts from your last APPROVED activity — not from the last time anything happened. Log a qualifying call and it starts again from today.",
    formula: "days since last approved activity, vs 21 / 30 / 45 for a prospect",
  },
  approvedActivity: {
    title: "Approved activity",
    body:
      "The only four things that reset the clock: a RingCentral call of 60 seconds or more that has been written up with a stage outcome; an email to or from a contact on file; an SMS the contact replies to; and a quote sent to a contact on the account.",
    formula: "call ≥ 60s AND stage chosen  ·  email to a contact ON FILE  ·  SMS with a reply  ·  quote",
  },
  lifecycleState: {
    title: "Status colour",
    body:
      "Green is worked recently. Amber means it has gone quiet and needs attention. Red means days from being taken. Dark red means the deadline has passed and the nightly sweep will release it. Blue is unclaimed. Navy means an approved request is holding the clock off.",
    formula: "prospect: amber at 21 days · red at 30 · released at 45",
  },
  daysLeft: {
    title: "Days left",
    body:
      "Days until this account returns to the available pool, if nothing else is logged against it. A negative number means the deadline has already passed and it is waiting for the nightly sweep.",
    formula: "release_days − days since last approved activity",
  },
  tenureActivities: {
    title: "Your activity count",
    body:
      "Approved activities logged since YOU picked this account up. It starts at zero when you claim it and resets to zero the moment it falls out of your name — including if you claim it again later. Earlier holders' work stays on the record but not on your counter.",
    formula: "count of approved activities where occurred_at ≥ your claim date",
  },
  lastCounted: {
    title: "Last counted",
    body:
      "The last activity that actually reset the clock. Different from Last contact: things can happen on an account without any of them counting, and the gap between the two columns is usually the whole story.",
  },
  lastContact: {
    title: "Last contact",
    body:
      "The last communication of any kind, whether it counted or not. A short call, an email to somebody not on file, a note — all appear here and none of them move the clock.",
  },
  protectedState: {
    title: "Protected",
    body:
      "An approved account request is holding the clock off. It cannot expire while the protection lasts, and the days shown are days of protection remaining rather than days until release.",
  },
  unlogged: {
    title: "Calls not written up",
    body:
      "Calls RingCentral captured that nobody has completed. A call is not an approved activity until it has a company, a contact, notes and a stage — so every one of these is an account running its clock down while the work has actually been done.",
  },

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------
  availablePool: {
    title: "Available pool",
    body:
      "Accounts nobody currently holds. Any broker can claim one, and the clock starts from the moment they do — a new holder never inherits the previous one's neglect.",
  },
  prospectLimit: {
    title: "Prospect limit",
    body:
      "How many accounts your tier allows you to hold. Under a year: 200. One to three years: 100. Three years and up: 100. National Account Directors: 250. The junior figure being the largest is deliberate — a new broker is building a book from nothing.",
  },
  ownershipTimeline: {
    title: "Ownership history",
    body:
      "Every person who has held this account, with the dates, how long they held it, why they lost it, and how much approved activity they logged inside their own window. Unclaimed stretches appear as segments too — that is when a competitor had a clear run at it.",
  },
  adOwner: {
    title: "Account Director",
    body:
      "A prospect has exactly one owner. A customer can carry two: if an Account Director set it up, a broker runs it day to day and the AD takes a share of the commission.",
  },
  accountRequest: {
    title: "Account requests",
    body:
      "Amnesty on a prospect, an extension on a customer, a transfer, an early release, or a promotion to national. You ask, somebody above you decides. Nobody can approve their own, and only one request can be open on an account at a time.",
  },
  duplicateFlag: {
    title: "Possible duplicate",
    body:
      "This account matches an existing one by name, address or main phone number. It is held by Credit until they confirm which record is the real one. Only Credit can edit it or hand it to a broker.",
  },

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------
  hitRate: {
    title: "Hit rate",
    body:
      "The share of calls that actually counted toward an account's clock. A low figure usually means calls under 60 seconds, or calls nobody wrote up — not a lack of effort.",
    formula: "approved calls ÷ total calls × 100",
  },
  callsCounted: {
    title: "Counted",
    body:
      "Calls that met the 60-second threshold AND were written up with a stage outcome. Both are required; either alone counts for nothing.",
  },
  atRisk: {
    title: "Needs attention",
    body:
      "Accounts past day 21 — amber, red, or already overdue. These are the ones you lose if nothing happens this week.",
    formula: "count where status is warning, expiring or overdue",
  },
  creditRollup: {
    title: "Combined exposure",
    body:
      "This company's own credit line plus every account beneath it in the hierarchy. Calculated when you open the page rather than stored, so it can never drift from the parts it is made of.",
    formula: "sum of credit_limit across this account and all descendants",
  },
  stageFunnel: {
    title: "Pipeline stage",
    body:
      "How far along the sale is: Lead, Contact, Pitch, Quote, Closed. The stage advances when a call is logged against it and never moves backwards on its own — a routine follow-up does not drag a Quote back to Contact.",
  },
  industryMix: {
    title: "Industry mix",
    body:
      "Where the book sits by vertical, with the converted share shown inside each bar. The useful reading is the ratio: a lot of accounts in one industry and none of them buying is a different problem from a few that all do.",
  },
  urgencySort: {
    title: "Most urgent first",
    body:
      "Sorted by how close each account is to being taken — overdue, then expiring, then needing attention, then everything else. Opening this screen should show you today's work without sorting anything.",
  },

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------
  filterIndustry: {
    title: "Industry filter",
    body:
      "Filters to one vertical, using the controlled Salesforce picklist. Because the list is controlled rather than free text, the count here is the real count — there is no second spelling hiding rows.",
  },
  filterState: {
    title: "State filter",
    body:
      "Filters by the state on the company's billing address. Case-insensitive, so NC and nc are the same thing. The number beside each state is how many accounts you can see there.",
  },
  filterQuiet: {
    title: "Quiet for",
    body:
      "Accounts with no APPROVED activity for at least this long. 'Never worked' means no approved activity has ever landed since the current holder claimed it.",
  },
  filterContacts: {
    title: "Contacts filter",
    body:
      "'Nobody on file' finds companies with no contact record. Those are invisible to the activity engine: no inbound call can be matched to them, and no email to them can ever count.",
  },
  filterHierarchy: {
    title: "Hierarchy filter",
    body:
      "Parents are accounts with service accounts beneath them; children are the accounts beneath a parent. Credit rolls up this tree — ownership does not.",
  },
  savedPreset: {
    title: "Presets",
    body:
      "One-click starting points. A preset only sets the filters — anything you change afterwards sticks, so you can start from 'At risk' and narrow it to one industry without leaving the preset.",
  },
} as const satisfies Record<string, Definition>;

export type DefinitionKey = keyof typeof RAW;

/**
 * Exported widened. `as const` above keeps the key names literal for the
 * DefinitionKey union, but it also narrows every value to its own exact shape,
 * so an entry without a `formula` makes the property invisible on the union and
 * reading it becomes a type error at the one place that renders it.
 */
export const DEFINITIONS: Record<DefinitionKey, Definition> = RAW;
