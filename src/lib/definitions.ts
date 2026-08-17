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

/**
 * The policy's numbers, written once.
 *
 * ---------------------------------------------------------------------------
 * These were typed into the prose by hand and then the policy changed. The
 * tooltips went on saying "amber at 21, released at 45" for a week after the
 * database had moved to 14 and 31, so the one explanation a broker could
 * actually open was the one thing on the screen lying to them.
 *
 * Interpolating them from a constant does not make the file self-updating --
 * nothing here reads the database -- but it does mean the numbers exist in ONE
 * place in the application, next to a test that checks them against
 * ensure_policy_thresholds() in 0018. Drift now fails a test instead of
 * quietly misinforming the floor.
 * ---------------------------------------------------------------------------
 */
export const POLICY = {
  prospect: { warning: 14, expiring: 21, release: 31 },
  customer: { warning: 90, expiring: 150, release: 181 },
} as const;

const P = POLICY.prospect;
const C = POLICY.customer;

const RAW = {
  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------
  clock: {
    title: "The clock",
    body:
      "How long you keep an account before it returns to the pool. It counts from your last APPROVED activity — not from the last time anything happened. Log a qualifying call and it starts again from today.",
    formula: `days since last approved activity · prospect ${P.warning} / ${P.expiring} / ${P.release} · customer ${C.warning} / ${C.expiring} / ${C.release}`,
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
      "Green is worked recently. Amber means it has gone quiet and needs attention. Orange means days from being taken. Solid red means the deadline has passed and the next sweep will release it. Blue is unclaimed. Navy means an approved request is holding the clock off.",
    formula: `prospect: amber at ${P.warning} days · orange at ${P.expiring} · released at ${P.release}`,
  },
  daysLeft: {
    title: "Days left",
    body:
      "Days until this account returns to the available pool, if nothing else is logged against it. A negative number means the deadline has already passed and it is waiting for the next sweep.",
    formula: "release days − days since last approved activity",
  },
  releaseSweep: {
    title: "The sweep",
    body:
      "The job that actually takes overdue accounts back. It runs on a schedule and also whenever somebody opens the dashboard or the account list and it has not run recently — so an account never sits overdue just because nobody triggered anything overnight.",
    formula: "runs if the last successful sweep is older than 15 minutes",
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
      "Every account nobody currently holds. Take one and it is yours immediately — first click wins, and the clock starts from that moment rather than carrying over the last holder's neglect. Recently released accounts are listed first, because somebody was working those until days ago.",
    formula: "accounts with no owner, newest release first",
  },
  claimAction: {
    title: "Claiming",
    body:
      "Takes the account into your name on the spot. If two brokers click at the same instant the database picks one winner and tells the other who beat them. Your activity counter starts at zero and the clock starts today.",
  },
  releaseAction: {
    title: "Releasing",
    body:
      "Hands the account back to the available pool for anyone to take. You can only release accounts you hold; an admin or Credit can release anyone's. The reason is recorded, so a deliberate hand-back reads differently from one lost to the clock.",
  },
  accountsHeld: {
    title: "Accounts held",
    body:
      "Companies currently in your name — prospects and customers together. Each one is running its own clock, and each needs approved activity to stay yours.",
    formula: "count of accounts where owner = you",
  },
  overseenAccounts: {
    title: "Yours and your brokers'",
    body:
      "Your own accounts plus every account held by anyone reporting to you, however far down. A manager holds a book like anybody else — this is that book added to theirs. Nobody's accounts are counted twice, and nobody outside your reporting line is included.",
    formula: "count of accounts owned by you or anyone beneath you",
  },
  accountDirector: {
    title: "Account Director",
    body:
      "Opens national accounts and co-owns them: a broker runs the account day to day and the AD takes a share of the commission. The broker's clock is the one that runs. An AD is not a manager — co-owning an account is not authority over the person running it, so they do not decide requests.",
  },
  prospectLimit: {
    title: "Prospect limit",
    body:
      "How many accounts your tier allows you to hold. Under a year: 200. One to three years: 100. Three years and up: 100. National Account Directors: 250. The junior figure being the largest is deliberate — a new broker is building a book from nothing.",
  },
  currentOwner: {
    title: "Owner",
    body:
      "The broker who holds this account right now, and the branch they work from. Blank means nobody holds it and any broker can claim it. Open the account's Ownership tab for everyone who has held it before.",
  },
  daysHeld: {
    title: "Days held",
    body:
      "How long the current owner has had this account, counted from the day they claimed it — not from the last activity. It keeps counting while the clock runs down, and starts again at zero for whoever claims it next.",
    formula: "days since claimed_at",
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
    title: "Calls that counted",
    body:
      "The share of your last seven days of calls that actually reset an account's clock. A low figure usually means calls under 60 seconds, or calls nobody wrote up — not a lack of effort.",
    formula: "approved calls ÷ total calls × 100, last 7 days",
  },
  callsSevenDays: {
    title: "Calls, last 7 days",
    body:
      "Every call RingCentral captured against your accounts in the last seven days, whether it counted or not. The smaller figure beneath is how many met the bar and moved a clock.",
    formula: "count of calls in the last 7 days · counted = ≥ 60s with a stage",
  },
  callsCounted: {
    title: "Counted",
    body:
      "Calls that met the 60-second threshold AND were written up with a stage outcome. Both are required; either alone counts for nothing.",
  },
  atRisk: {
    title: "Needs attention",
    body:
      `Accounts that have gone quiet long enough to be at risk — amber, orange, or already past the deadline. For a prospect that starts at day ${P.warning}. These are the ones you lose if nothing happens this week.`,
    formula: "count where status is warning, expiring or overdue",
  },
  expiringSoon: {
    title: "Expiring",
    body:
      `Accounts inside the last stretch before release — past day ${P.expiring} for a prospect. Days, not weeks. An approved activity today resets each one to zero.`,
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
  // Screens
  //
  // One per screen, answering the question somebody has on arriving at it for
  // the first time: what am I looking at, and whose data is it? The second half
  // matters more than it sounds -- almost every list here is scoped by who you
  // are, and "why can my manager see more rows than me" is the single most
  // common misreading of the whole application.
  // -------------------------------------------------------------------------
  activityFeed: {
    title: "Activity",
    body:
      "Every call, email, SMS and quote captured against the accounts you can see, newest first. The green mark means it counted toward an account's clock; the rest happened but moved nothing.",
    formula: "all activities on accounts visible to you",
  },
  contactsScreen: {
    title: "Contacts",
    body:
      "The people on file at your accounts. This list is what the call matcher works from — an inbound number that matches nobody here cannot be attributed, so it lands in the review queue instead of resetting a clock.",
  },
  reviewQueue: {
    title: "Review queue",
    body:
      "Calls the system could not attribute on its own: an unknown number, or a number that appears at two different companies. Nothing is guessed — attaching a call to the wrong company is more expensive than asking. Resolving one here turns it into a real activity.",
  },
  myBook: {
    title: "Your book",
    body:
      "Everything currently in your name, with your own calling figures beside it. Nobody else's accounts appear here, including your manager's — this is the one screen that is strictly yours.",
  },
  reportsScreen: {
    title: "Reports",
    body:
      "The same figures the dashboard shows, over a period you choose and broken down by person, branch, stage, industry and state. Every number is scoped by what you are allowed to see, so a manager's totals are their line of the org chart and nobody else's.",
  },
  leaderboard: {
    title: "By rep",
    body:
      "Each broker's calls, how many counted, and how many accounts they hold. Ordered by counted calls rather than raw volume, because volume rewards short calls and this rewards the ones that actually moved a clock.",
    formula: "per broker: calls · approved calls · accounts held",
  },
  byBranch: {
    title: "By branch",
    body:
      "The same figures grouped by office rather than person, taken from each broker's location. A branch with no location set on its people will not appear.",
  },
  clockDistribution: {
    title: "Where the clock stands",
    body:
      "How the book splits across the lifecycle states right now. A healthy book is mostly green with a thin amber edge; a large orange or red share means accounts are being held rather than worked.",
  },
  statusMix: {
    title: "By status",
    body:
      "Prospects against customers. The ratio is the useful part — a book that is almost all prospects has not converted anything yet, and one that is almost all customers has stopped hunting.",
  },
  callingTrend: {
    title: "Calling over time",
    body:
      "Calls per day across the period, with the counted share shaded inside each bar. The gap between the bar and the shading is the work being done that the clock is not seeing.",
  },
  approvedActivityRules: {
    title: "What counts",
    body:
      "The editable rules behind every clock in the system. Change a threshold here and every screen, every report and the nightly digest change with it — the state is computed on read, never stored, so nothing can be left disagreeing.",
  },
  knownGaps: {
    title: "Known gaps",
    body:
      "Things this build does not do yet, listed rather than hidden. Written down because a gap somebody knows about is a decision, and a gap they discover in front of a customer is a fault.",
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

/**
 * Which definition sits behind each account-list column header.
 *
 * Kept beside the registry rather than in the table component, so adding a
 * column and forgetting to explain it is visible in one file.
 */
export const COLUMN_HELP: Record<string, DefinitionKey | undefined> = {
  name: undefined,
  // The column shows who holds it TODAY. It pointed at the ownership-history
  // definition, which describes a different thing entirely -- every past holder
  // and the gaps between them -- and read as an answer to a question nobody on
  // this screen had asked.
  owner: "currentOwner",
  location: "filterState",
  industry: "filterIndustry",
  status: undefined,
  stage: "stageFunnel",
  phone: undefined,
  website: undefined,
  parent: "filterHierarchy",
  credit: "creditRollup",
  contacted: "lastContact",
  activity: "lastCounted",
  clock: "clock",
};
