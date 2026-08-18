import { describe, expect, it } from "vitest";
import { greetingFor } from "@/lib/greeting";

/**
 * The greeting boundaries, which are the entire content of the rule.
 *
 * ===========================================================================
 * Alex specified these to the minute:
 *
 *   00:00 – 11:59   Good morning
 *   12:00 – 17:30   Good afternoon
 *   17:31 – 23:59   Good evening
 *
 * Every one of those five edges is a place to be off by a minute, and being
 * wrong about it is invisible -- a greeting is never checked against a clock.
 * So each edge is asserted on both sides.
 *
 * Local time throughout, deliberately: the component that calls this runs in
 * the browser precisely so "half past five" means half past five where the
 * person is sitting.
 * ===========================================================================
 */

/** A Date at a given hour and minute today, in the local zone. */
function at(hour: number, minute = 0): Date {
  const d = new Date(2026, 7, 18, hour, minute, 0, 0);
  return d;
}

describe("morning", () => {
  it("starts at midnight", () => {
    expect(greetingFor(at(0, 0))).toBe("Good morning");
  });

  it("covers the small hours and the working morning", () => {
    expect(greetingFor(at(3, 15))).toBe("Good morning");
    expect(greetingFor(at(9, 0))).toBe("Good morning");
  });

  it("holds until the last minute before noon", () => {
    expect(greetingFor(at(11, 59))).toBe("Good morning");
  });
});

describe("afternoon", () => {
  it("begins exactly at noon", () => {
    // The first edge. 11:59 is morning, 12:00 is not.
    expect(greetingFor(at(12, 0))).toBe("Good afternoon");
  });

  it("covers the afternoon", () => {
    expect(greetingFor(at(14, 30))).toBe("Good afternoon");
    expect(greetingFor(at(17, 0))).toBe("Good afternoon");
  });

  it("includes half past five itself", () => {
    // The edge that cannot be decided on the hour alone, and the reason this
    // function reads minutes at all. 17:30 is afternoon; 17:31 is not.
    expect(greetingFor(at(17, 30))).toBe("Good afternoon");
  });
});

describe("evening", () => {
  it("begins one minute after half past five", () => {
    expect(greetingFor(at(17, 31))).toBe("Good evening");
  });

  it("covers the rest of the day", () => {
    expect(greetingFor(at(18, 0))).toBe("Good evening");
    expect(greetingFor(at(21, 45))).toBe("Good evening");
  });

  it("holds until the last minute of the day", () => {
    expect(greetingFor(at(23, 59))).toBe("Good evening");
  });

  it("does not run past midnight", () => {
    // The wrap. Ten past midnight is morning, not a very long evening.
    expect(greetingFor(at(0, 10))).toBe("Good morning");
  });
});

describe("every minute of the day lands somewhere", () => {
  it("returns exactly one of the three, all 1440 times", () => {
    // Cheap, and it rules out a whole class of off-by-one where a minute falls
    // through every branch or two ranges overlap.
    const seen = new Map<string, number>();
    for (let m = 0; m < 24 * 60; m++) {
      const said = greetingFor(at(Math.floor(m / 60), m % 60));
      seen.set(said, (seen.get(said) ?? 0) + 1);
    }

    expect(seen.get("Good morning")).toBe(12 * 60); // 00:00–11:59
    expect(seen.get("Good afternoon")).toBe(5 * 60 + 31); // 12:00–17:30
    expect(seen.get("Good evening")).toBe(6 * 60 + 29); // 17:31–23:59
    expect([...seen.values()].reduce((a, b) => a + b, 0)).toBe(1440);
  });
});
