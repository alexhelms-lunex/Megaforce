/**
 * What a person can change about their own experience.
 *
 * A plain module, not part of the server actions file: a "use server" module
 * may only export async functions, and a constant living there fails the build
 * at page-collection time, long after the code looks correct.
 */

export interface Preferences {
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  /** Overrides keyed by lifecycle state, each a hex colour. */
  lifecycle_colors: Record<string, string>;
  default_landing: string;
  default_account_preset: string;
  /**
   * Rows in a list before it pages.
   *
   * Alex asked for 100 as the default with a toggle from 10 to 200. 100 rather
   * than 50 because the complaint underneath the request was scrolling and
   * paging, not screen space -- and a broker scanning their book for one
   * company would rather read a long page than press Next four times.
   */
  rows_per_page: number;
  timezone: string;
  alerts: Record<string, { app: boolean; email: boolean }>;
  show_tips: boolean;
  compact_sidebar: boolean;
  warn_at_limit: boolean;
  sound_on_call: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  density: "comfortable",
  lifecycle_colors: {},
  default_landing: "/",
  default_account_preset: "my-book",
  rows_per_page: 100,
  timezone: "America/New_York",
  alerts: {
    account_expiring: { app: true, email: true },
    account_released: { app: true, email: true },
    request_decided: { app: true, email: true },
    call_unlogged: { app: true, email: false },
    account_assigned: { app: true, email: true },
    duplicate_flagged: { app: true, email: false },
    daily_digest: { app: false, email: true },
  },
  show_tips: true,
  compact_sidebar: false,
  warn_at_limit: true,
  sound_on_call: false,
};

/**
 * The events somebody can be told about, in the order they matter.
 *
 * Every one of these is a thing that happens TO a broker rather than something
 * they did, which is the whole test for whether it deserves a notification.
 */
export const ALERT_TYPES: {
  key: string;
  label: string;
  help: string;
  /** Some alerts are too important to switch off entirely. */
  emailLocked?: boolean;
}[] = [
  {
    key: "account_expiring",
    label: "An account of mine is about to expire",
    help: "Sent when an account you hold passes day 21 and enters the amber band.",
  },
  {
    key: "account_released",
    label: "I lost an account",
    help: "Sent when the nightly sweep takes an account off you and returns it to the pool.",
  },
  {
    key: "request_decided",
    label: "A request of mine was decided",
    help: "Amnesty, extension, transfer or promotion — approved or denied, with the reason.",
  },
  {
    key: "call_unlogged",
    label: "I have calls to write up",
    help: "A reminder that captured calls are sitting unwritten, and their accounts are still running down.",
  },
  {
    key: "account_assigned",
    label: "An account was assigned to me",
    help: "Somebody transferred an account into your name, or a manager assigned one.",
  },
  {
    key: "duplicate_flagged",
    label: "A duplicate I created was flagged",
    help: "Credit has been given an account you created because it matched an existing record.",
  },
  {
    key: "daily_digest",
    label: "The morning digest",
    help: "The 5am summary of your book: what needs attention, what you have to write up, where you stand against your limit.",
  },
];

export const LANDING_OPTIONS = [
  { value: "/", label: "Dashboard" },
  { value: "/accounts", label: "Accounts" },
  { value: "/activity", label: "Activity" },
  { value: "/me", label: "My book" },
  { value: "/reports", label: "Reports" },
];

/** Common US timezones. A full tz list is a thousand entries nobody scrolls. */
export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

/**
 * The page sizes on offer.
 *
 * Five steps rather than a free-text box. A number typed by hand can be 3 or
 * 5000, and both of those are a slow screen for a different reason.
 */
export const PAGE_SIZES = [10, 25, 50, 100, 200] as const;

/**
 * Whatever arrived, turned into a page size that exists.
 *
 * Takes the URL first and the stored preference second, so a link somebody was
 * sent shows what the sender saw. Anything unrecognised falls back rather than
 * throwing: a hand-edited URL should show a normal page, not an error.
 */
export function resolvePageSize(fromUrl: string | undefined, stored: number | undefined): number {
  const asked = Number.parseInt(fromUrl ?? "", 10);
  if ((PAGE_SIZES as readonly number[]).includes(asked)) return asked;
  if (stored && (PAGE_SIZES as readonly number[]).includes(stored)) return stored;
  return 100;
}
