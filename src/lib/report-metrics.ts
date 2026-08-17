/**
 * The report vocabulary: metrics, windows and the arithmetic between them.
 *
 * ---------------------------------------------------------------------------
 * The shape here mirrors 0019: a WINDOW, a set of METRICS, and a set of
 * DIMENSIONS. Everything the screen shows is a combination of the three, which
 * is why there is one fetcher per concept rather than one per card.
 *
 * SEPARATE FROM THE FETCHERS ON PURPOSE. The controls on the reports screen are
 * client components and need the metric catalogue; the fetchers reach for
 * next/headers, which cannot cross into a client bundle. Keeping the two apart
 * means the catalogue is shared rather than duplicated -- and a duplicated
 * metric list is a metric list that will disagree with itself.
 * ---------------------------------------------------------------------------
 */

export type Scope = "mine" | "team";
export type Grain = "day" | "week";

/** The metrics the engine returns, in the order the screen shows them. */
export const METRICS = [
  {
    key: "calls",
    label: "Calls",
    hint: "Every call captured, counted or not.",
    good: "up" as const,
  },
  {
    key: "approved",
    label: "Counted",
    hint: "Activities that reset an account's clock.",
    good: "up" as const,
  },
  {
    key: "hit_rate",
    label: "Hit rate",
    hint: "Share of calls that counted.",
    good: "up" as const,
    suffix: "%",
  },
  {
    key: "claimed",
    label: "Claimed",
    hint: "Accounts taken out of the available pool.",
    good: "up" as const,
  },
  {
    key: "lost",
    label: "Lost to the clock",
    hint: "Accounts that timed out and went back to the pool.",
    good: "down" as const,
  },
  {
    key: "emails",
    label: "Emails",
    hint: "Emails to or from contacts on file.",
    good: "up" as const,
  },
  {
    key: "contacts_added",
    label: "Contacts added",
    hint: "New people put on file.",
    good: "up" as const,
  },
  {
    key: "accounts_held",
    label: "Accounts held",
    hint: "Held right now. A snapshot, so it carries no comparison.",
    good: "up" as const,
  },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

/** The metrics the trend chart can draw. hit_rate and the snapshot cannot. */
export const SERIES_METRICS = ["calls", "approved", "emails", "claimed", "lost"] as const;
export type SeriesKey = (typeof SERIES_METRICS)[number];

export interface MetricValue {
  key: MetricKey;
  label: string;
  hint: string;
  value: number;
  previous: number | null;
  /** Percentage change against the previous period. Null when incomparable. */
  delta: number | null;
  good: "up" | "down";
  suffix?: string;
}

export interface SeriesPoint {
  bucket: string;
  calls: number;
  approved: number;
  emails: number;
  claimed: number;
  lost: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  calls: number;
  approved: number;
  hitRate: number;
  accounts: number;
  claimed: number;
  lost: number;
  /** The same two figures from the comparison window. Null when unavailable. */
  prevCalls: number | null;
  prevApproved: number | null;
}

export interface ReportError {
  message: string;
  /** True when the cause is a database older than this deployment. */
  schema: boolean;
}

export function classify(message: string): ReportError {
  return {
    message,
    schema: /does not exist|schema cache|could not find|function/i.test(message),
  };
}

/** ISO date, n days back from today, in UTC. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Periods
//
// Alex: "A period is 7 days for our sake. A period begins on Monday and ends on
// Sunday evening."
//
// That is not a cosmetic relabelling of the old day counts. "The last 28 days"
// starts on whatever weekday you happen to open the screen, so a Friday report
// and a Monday report cover different Mondays -- and every week-over-week
// comparison drawn from them silently compares four Fridays against three.
// Anchoring to Monday makes two reports of the same period identical whoever
// runs them and whenever.
//
// Everything below is UTC. The whole reporting engine is: the buckets in
// report_series come from Postgres date_trunc, which starts its weeks on Monday
// too, so the app and the database agree on where a week begins without either
// having to be told.
// ---------------------------------------------------------------------------

/** Days per week, named so the arithmetic below reads as weeks. */
const WEEK = 7;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The Monday of the week an ISO date falls in.
 *
 * getUTCDay() calls Sunday 0, so Sunday has to walk back six days rather than
 * forward one. Getting that backwards moves one day in seven into the wrong
 * week, which is the kind of bug that shows up as "the numbers were fine except
 * last Sunday".
 */
export function mondayOf(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % WEEK));
}

export interface Period {
  key: PeriodKey;
  from: string;
  to: string;
  /** Weeks the window spans, used to step the comparison back cleanly. */
  weeks: number;
  /** True while the last week in it is still running. */
  partial: boolean;
}

export const PERIODS = [
  { key: "this-week", label: "This week", weeks: 1 },
  { key: "last-week", label: "Last week", weeks: 1 },
  { key: "4-weeks", label: "4 weeks", weeks: 4 },
  { key: "13-weeks", label: "13 weeks", weeks: 13 },
  { key: "52-weeks", label: "52 weeks", weeks: 52 },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

export function isPeriodKey(value: string): value is PeriodKey {
  return PERIODS.some((p) => p.key === value);
}

/**
 * Resolve a period into the two dates the queries actually take.
 *
 * "This week" runs Monday to today and says so. Every other period ends on the
 * last COMPLETED Sunday, deliberately: a four-week window that quietly includes
 * two days of the current week is being compared against four whole weeks, and
 * the report says the team is down when it is only Tuesday.
 */
export function resolvePeriod(key: PeriodKey, today = isoToday()): Period {
  const thisMonday = mondayOf(today);
  const lastSunday = addDays(thisMonday, -1);

  switch (key) {
    case "this-week":
      return { key, from: thisMonday, to: today, weeks: 1, partial: today !== addDays(thisMonday, 6) };
    case "last-week":
      return { key, from: addDays(thisMonday, -WEEK), to: lastSunday, weeks: 1, partial: false };
    default: {
      const weeks = PERIODS.find((p) => p.key === key)?.weeks ?? 4;
      return { key, from: addDays(lastSunday, -(weeks * WEEK - 1)), to: lastSunday, weeks, partial: false };
    }
  }
}

export const COMPARISONS = [
  {
    key: "previous",
    label: "Previous period",
    hint: "The same length of time immediately before this period.",
  },
  {
    key: "previous-week",
    label: "A week earlier",
    hint: "The identical window shifted back seven days. Same weekdays, same length.",
  },
  {
    key: "last-year",
    label: "Same weeks last year",
    hint:
      "Fifty-two weeks back. Not a calendar year — 364 days, so the window lands on a " +
      "Monday again and Tuesdays are compared against Tuesdays.",
  },
  { key: "none", label: "No comparison", hint: "Show the figures on their own." },
] as const;

export type CompareKey = (typeof COMPARISONS)[number]["key"];

export function isCompareKey(value: string): value is CompareKey {
  return COMPARISONS.some((c) => c.key === value);
}

export interface CompareWindow {
  key: CompareKey;
  from: string | null;
  to: string | null;
  label: string;
}

/**
 * The window a period is measured against.
 *
 * Three shifts, all of whole weeks, which is the only way a Monday-anchored
 * window stays Monday-anchored:
 *
 *   previous       back by the period's own length in whole weeks. For a part-
 *                  finished week that is seven days, so Monday-to-Wednesday is
 *                  compared against last Monday-to-Wednesday rather than
 *                  against the Friday-to-Sunday that immediately preceded it.
 *   previous-week  back seven days, whatever the length.
 *   last-year      back 364 days. 365 would move the window onto a Sunday and
 *                  compare six weekdays against five.
 */
export function resolveCompare(period: Period, key: CompareKey): CompareWindow {
  if (key === "none") return { key, from: null, to: null, label: "no comparison" };

  const shift =
    key === "previous" ? period.weeks * WEEK : key === "last-year" ? 52 * WEEK : WEEK;

  return {
    key,
    from: addDays(period.from, -shift),
    to: addDays(period.to, -shift),
    label: COMPARISONS.find((c) => c.key === key)?.label.toLowerCase() ?? "the previous period",
  };
}

/** "18 Aug – 24 Aug", or a single date when the window is one day long. */
export function formatWindow(from: string, to: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

/** Whole days between two ISO dates, inclusive of both ends. */
export function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/**
 * Daily up to about three months, weekly beyond.
 *
 * Chosen rather than asked. Nobody has an opinion about bucket size until the
 * chart is unreadable, at which point the opinion is "this is unreadable".
 */
export function grainFor(from: string, to: string): Grain {
  return spanDays(from, to) > 92 ? "week" : "day";
}

export function rate(part: number | undefined, whole: number | undefined): number {
  if (!whole) return 0;
  return Math.round(((part ?? 0) / whole) * 1000) / 10;
}

/**
 * Percent change, with the two cases that produce nonsense handled.
 *
 * Growing from zero is not "infinity percent" and is not "zero percent"; it is
 * a comparison that cannot be expressed as a percentage, so it is not shown as
 * one.
 */
export function percentChange(now: number, before: number | null): number | null {
  if (before === null) return null;
  if (before === 0) return now === 0 ? 0 : null;
  return ((now - before) / before) * 100;
}
