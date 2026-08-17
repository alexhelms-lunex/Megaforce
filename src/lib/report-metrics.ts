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
