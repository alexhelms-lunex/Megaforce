import { describe, expect, it } from "vitest";
import {
  COMPARISONS,
  METRICS,
  SERIES_METRICS,
  daysAgo,
  formatWindow,
  grainFor,
  isCompareKey,
  isPeriodKey,
  mondayOf,
  percentChange,
  resolveCompare,
  resolvePeriod,
  spanDays,
} from "./report-metrics";

/**
 * The arithmetic behind the report header.
 *
 * Small functions, and every one of them has a case that produces nonsense if
 * it is not handled: a percentage change from zero, a range that crosses a
 * month boundary, a bucket size chosen for a span nobody anticipated. These are
 * the numbers a manager reads first and questions last.
 */

describe("percent change", () => {
  it("is the ordinary calculation when both figures are real", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("refuses to express growth from zero as a percentage", () => {
    // Not infinity, and certainly not 100%. Twelve calls after a week of none
    // is a real fact and it is not a percentage, so the screen says "new"
    // rather than inventing a number somebody might quote.
    expect(percentChange(12, 0)).toBeNull();
  });

  it("treats nothing-then-nothing as flat rather than as unknown", () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it("has no comparison at all when the previous period is unknown", () => {
    // Accounts held is a snapshot. There is no history table, so "held last
    // week" is unknowable -- and inventing it would be worse than omitting it.
    expect(percentChange(40, null)).toBeNull();
  });
});

describe("the window", () => {
  it("counts both ends of the range", () => {
    expect(spanDays("2026-01-01", "2026-01-07")).toBe(7);
    expect(spanDays("2026-01-01", "2026-01-01")).toBe(1);
  });

  it("crosses month and year boundaries correctly", () => {
    expect(spanDays("2026-01-28", "2026-02-03")).toBe(7);
    expect(spanDays("2025-12-29", "2026-01-04")).toBe(7);
  });

  it("survives a malformed date rather than returning NaN days", () => {
    expect(spanDays("not-a-date", "2026-01-07")).toBe(1);
  });

  it("counts back the right number of days", () => {
    // A 7-day report is today plus the six before it, which is why the page
    // asks for daysAgo(days - 1) rather than daysAgo(days).
    expect(spanDays(daysAgo(6), daysAgo(0))).toBe(7);
    expect(spanDays(daysAgo(27), daysAgo(0))).toBe(28);
  });
});

describe("bucket size", () => {
  it("stays daily for anything up to about three months", () => {
    expect(grainFor(daysAgo(6), daysAgo(0))).toBe("day");
    expect(grainFor(daysAgo(89), daysAgo(0))).toBe("day");
  });

  it("switches to weekly for a year, so the chart is a trend and not noise", () => {
    expect(grainFor(daysAgo(364), daysAgo(0))).toBe("week");
  });
});

describe("the metric catalogue", () => {
  it("marks accounts lost to the clock as a figure that should be falling", () => {
    // Up is not automatically good. A green arrow on a rising loss figure is
    // worse than no arrow at all.
    expect(METRICS.find((m) => m.key === "lost")?.good).toBe("down");
    expect(METRICS.find((m) => m.key === "approved")?.good).toBe("up");
  });

  it("only offers chartable metrics to the chart", () => {
    // Hit rate is a ratio and accounts held is a snapshot; neither has a
    // meaningful daily series, and plotting them beside counts would put two
    // incompatible scales on one axis.
    expect(SERIES_METRICS).not.toContain("hit_rate");
    expect(SERIES_METRICS).not.toContain("accounts_held");
  });

  it("explains every metric, since each card carries its own tooltip", () => {
    for (const m of METRICS) {
      expect(m.hint.length, `${m.key} has no hint`).toBeGreaterThan(15);
    }
  });

  it("keeps every chartable metric in the catalogue", () => {
    const known = METRICS.map((m) => m.key as string);
    for (const s of SERIES_METRICS) {
      expect(known, `${s} is chartable but has no card`).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Periods
//
// Alex: "A period is 7 days for our sake. A period begins on Monday and ends on
// Sunday evening."
//
// Every case below is dated explicitly rather than derived from "today",
// because a test that computes its own expectation the same way the code does
// proves only that the code is self-consistent. 2026-08-17 is a Monday;
// 2026-08-19 a Wednesday; 2026-08-16 a Sunday.
// ---------------------------------------------------------------------------

describe("where a week starts", () => {
  it("returns the day itself when it is already a Monday", () => {
    expect(mondayOf("2026-08-17")).toBe("2026-08-17");
  });

  it("walks back to Monday from the middle of the week", () => {
    expect(mondayOf("2026-08-19")).toBe("2026-08-17");
    expect(mondayOf("2026-08-21")).toBe("2026-08-17");
  });

  it("puts Sunday at the END of its week, not the start of the next one", () => {
    // The one that JavaScript gets wrong for you if you let it: getUTCDay()
    // calls Sunday 0, so a naive subtraction moves Sunday forward a week and
    // one day in seven lands in the wrong period.
    expect(mondayOf("2026-08-16")).toBe("2026-08-10");
  });

  it("crosses a month and a year boundary", () => {
    expect(mondayOf("2026-03-01")).toBe("2026-02-23");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });
});

describe("resolving a period", () => {
  const wednesday = "2026-08-19";

  it("runs this week from Monday to today, and knows it is unfinished", () => {
    const p = resolvePeriod("this-week", wednesday);
    expect([p.from, p.to]).toEqual(["2026-08-17", "2026-08-19"]);
    expect(p.partial).toBe(true);
  });

  it("stops calling this week partial once Sunday arrives", () => {
    const p = resolvePeriod("this-week", "2026-08-23");
    expect([p.from, p.to]).toEqual(["2026-08-17", "2026-08-23"]);
    expect(p.partial).toBe(false);
  });

  it("runs last week Monday to Sunday, whatever day it is asked on", () => {
    for (const today of ["2026-08-17", "2026-08-19", "2026-08-23"]) {
      const p = resolvePeriod("last-week", today);
      expect([p.from, p.to], `asked on ${today}`).toEqual(["2026-08-10", "2026-08-16"]);
    }
  });

  it("ends every multi-week period on the last completed Sunday", () => {
    // Not on today. A four-week window that quietly includes two days of the
    // current week gets compared against four whole weeks, and the report says
    // the team is down when it is only Tuesday.
    const p = resolvePeriod("4-weeks", wednesday);
    expect([p.from, p.to]).toEqual(["2026-07-20", "2026-08-16"]);
    expect(p.partial).toBe(false);
  });

  it("spans exactly the number of whole weeks it is named after", () => {
    for (const [key, weeks] of [["4-weeks", 4], ["13-weeks", 13], ["52-weeks", 52]] as const) {
      const p = resolvePeriod(key, wednesday);
      expect(spanDays(p.from, p.to), key).toBe(weeks * 7);
      expect(mondayOf(p.from), `${key} starts on a Monday`).toBe(p.from);
    }
  });

  it("gives the same answer on Friday as on Monday", () => {
    // The whole point of anchoring. Two people running the same report in the
    // same week must be looking at the same numbers.
    for (const key of ["last-week", "4-weeks", "13-weeks", "52-weeks"] as const) {
      expect(resolvePeriod(key, "2026-08-17"), key).toEqual(resolvePeriod(key, "2026-08-21"));
    }
  });
});

describe("choosing what to compare against", () => {
  const fourWeeks = resolvePeriod("4-weeks", "2026-08-19");
  const partWeek = resolvePeriod("this-week", "2026-08-19");

  it("steps a full period back for the previous period", () => {
    const c = resolveCompare(fourWeeks, "previous");
    expect([c.from, c.to]).toEqual(["2026-06-22", "2026-07-19"]);
    // Butts directly against the period, with no day in both and none missed.
    expect(c.to).toBe("2026-07-19");
    expect(spanDays(c.from!, c.to!)).toBe(spanDays(fourWeeks.from, fourWeeks.to));
  });

  it("compares a part-finished week against the same days of the week before", () => {
    // Monday-to-Wednesday against last Monday-to-Wednesday. The literal
    // preceding three days would be Friday to Sunday, which is a weekend
    // compared against a working week and reads as a collapse in call volume.
    const c = resolveCompare(partWeek, "previous");
    expect([c.from, c.to]).toEqual(["2026-08-10", "2026-08-12"]);
  });

  it("shifts exactly seven days for a week earlier, whatever the length", () => {
    const c = resolveCompare(fourWeeks, "previous-week");
    expect([c.from, c.to]).toEqual(["2026-07-13", "2026-08-09"]);
  });

  it("uses 364 days for last year, so weekdays line up with weekdays", () => {
    // 365 would land the window on a Sunday and compare six weekdays against
    // five, which reads as a 20% collapse that never happened.
    const c = resolveCompare(fourWeeks, "last-year");
    expect(mondayOf(c.from!)).toBe(c.from);
    expect(spanDays(c.from!, c.to!)).toBe(spanDays(fourWeeks.from, fourWeeks.to));
    expect([c.from, c.to]).toEqual(["2025-07-21", "2025-08-17"]);
  });

  it("returns no window at all when the comparison is switched off", () => {
    const c = resolveCompare(fourWeeks, "none");
    expect(c.from).toBeNull();
    expect(c.to).toBeNull();
  });

  it("keeps every comparison the same length as the period it measures", () => {
    for (const period of [partWeek, fourWeeks, resolvePeriod("52-weeks", "2026-08-19")]) {
      for (const key of ["previous", "previous-week", "last-year"] as const) {
        const c = resolveCompare(period, key);
        expect(spanDays(c.from!, c.to!), `${period.key}/${key}`)
          .toBe(spanDays(period.from, period.to));
      }
    }
  });
});

describe("the period and comparison menus", () => {
  it("only accepts keys it actually offers", () => {
    expect(isPeriodKey("4-weeks")).toBe(true);
    expect(isPeriodKey("28")).toBe(false);
    expect(isCompareKey("last-year")).toBe(true);
    expect(isCompareKey("yesterday")).toBe(false);
  });

  it("explains every comparison, since each one is a different question", () => {
    for (const c of COMPARISONS) expect(c.hint.length).toBeGreaterThan(10);
  });
});

describe("writing a window out", () => {
  it("reads as a range a person would say out loud", () => {
    expect(formatWindow("2026-08-17", "2026-08-23")).toBe("Aug 17 – Aug 23");
  });

  it("collapses to one date when the window is a single day", () => {
    expect(formatWindow("2026-08-17", "2026-08-17")).toBe("Aug 17");
  });
});
