/**
 * Good morning / afternoon / evening.
 *
 * ===========================================================================
 * THE BOUNDARIES ARE ALEX'S, TO THE MINUTE
 *
 *   00:00 – 11:59   Good morning
 *   12:00 – 17:30   Good afternoon
 *   17:31 – 23:59   Good evening
 *
 * Note that 17:30 is still afternoon and 17:31 is evening, so this cannot be
 * decided on the hour alone. The previous version compared `getHours() < 18`,
 * which puts half past five in the afternoon and twenty to six in the
 * afternoon too.
 *
 * A pure function taking a Date, for two reasons. It is the only way to test
 * the boundaries -- and boundaries are the entire content of this rule -- and
 * it keeps the arithmetic in one place now that two dashboards render it. Both
 * had their own copy, identical and separately wrong.
 * ===========================================================================
 */

/** 12:00, in minutes past midnight. */
const NOON = 12 * 60;
/** 17:30, inclusive: the last minute that still counts as afternoon. */
const EVENING_STARTS_AFTER = 17 * 60 + 30;

export function greetingFor(now: Date): string {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < NOON) return "Good morning";
  if (minutes <= EVENING_STARTS_AFTER) return "Good afternoon";
  return "Good evening";
}
