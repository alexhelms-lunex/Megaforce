import { describe, expect, it } from "vitest";
import {
  METRICS,
  SERIES_METRICS,
  daysAgo,
  grainFor,
  percentChange,
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
