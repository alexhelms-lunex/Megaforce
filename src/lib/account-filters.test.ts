import { describe, expect, it } from "vitest";
import { parseFilters, toQueryString, PRESETS } from "@/lib/account-filters";

/**
 * Turning filters into a URL and back.
 *
 * ===========================================================================
 * THE ROUND TRIP IS THE WHOLE CONTRACT
 *
 * Every filter control on the accounts screen works by writing a URL and
 * reading it back on the next render. So a filter that cannot survive the round
 * trip is a filter that does not work -- and it fails silently, because the page
 * navigates, re-renders, and shows the old state as though nothing was pressed.
 *
 * That is exactly what happened to the ✕ on a chip. A preset is applied first
 * and overridden by explicit parameters, and toQueryString dropped anything
 * empty -- so clearing a filter the preset supplies handed the decision straight
 * back to the preset, which supplied the same value again. Press ✕, watch
 * nothing happen, press it again.
 *
 * These tests are written against the ACTUAL presets rather than fixtures. The
 * bug lives in the interaction between the two, and a fixture preset would test
 * a preset nobody uses.
 * ===========================================================================
 */

/** What the browser ends up parsing, after a chip is cleared. */
function roundTrip(patch: Parameters<typeof toQueryString>[0]) {
  const qs = toQueryString(patch);
  return parseFilters(Object.fromEntries(new URLSearchParams(qs)));
}

// ===========================================================================
describe("clearing a filter the preset supplies", () => {
  it("clears 'Only mine' on a preset that sets it", () => {
    // The exact press that did nothing. Every preset but the pool sets mine.
    const current = parseFilters({ preset: "expiring" });
    expect(current.mine).toBe(true);

    const after = roundTrip({ ...current, mine: false });
    expect(after.mine).toBe(false);
  });

  it("clears the state chip on the Expiring preset", () => {
    const current = parseFilters({ preset: "expiring" });
    expect(current.state).toBe("expiring");

    const after = roundTrip({ ...current, state: "" });
    expect(after.state).toBe("");
  });

  it("leaves the rest of the preset alone", () => {
    // Clearing one chip must not be a back door to clearing all of them --
    // the cheap fix for this bug is to drop the preset, and that silently
    // widens the result set to every company in the system.
    const current = parseFilters({ preset: "expiring" });
    const after = roundTrip({ ...current, mine: false });

    expect(after.state).toBe("expiring");
    expect(after.preset).toBe("expiring");
  });

  it("clears 'Unclaimed only' on the pool preset", () => {
    const current = parseFilters({ preset: "pool" });
    expect(current.unowned).toBe(true);

    expect(roundTrip({ ...current, unowned: false }).unowned).toBe(false);
  });

  it("clears the status chip on My customers", () => {
    const current = parseFilters({ preset: "my-customers" });
    expect(current.status).toBe("customer");

    expect(roundTrip({ ...current, status: "" }).status).toBe("");
  });

  it("clears the idle chip on Never worked", () => {
    const current = parseFilters({ preset: "never-worked" });
    expect(current.idle).toBe("none");

    expect(roundTrip({ ...current, idle: "" }).idle).toBe("");
  });

  /*
   * Every preset, every field it sets. New presets get this for free, which
   * matters because the bug is invisible until somebody presses the ✕ on the
   * one chip nobody tried.
   */
  it("clears every filter that every preset sets", () => {
    for (const preset of PRESETS) {
      const current = parseFilters({ preset: preset.key });

      for (const [field, value] of Object.entries(preset.filters)) {
        if (field === "sort" || !value) continue;

        const cleared = typeof value === "boolean" ? false : "";
        const after = roundTrip({ ...current, [field]: cleared });

        expect(
          after[field as keyof typeof after],
          `${preset.key} → ${field} would not clear`,
        ).toBe(cleared);
      }
    }
  });
});

// ===========================================================================
describe("the URL stays readable", () => {
  it("carries no empty parameters when there is no preset", () => {
    // The fix writes explicit empties, and it must do so ONLY where a preset
    // would otherwise override. A plain filtered URL carrying a dozen empty
    // parameters is unreadable and unshareable.
    const qs = toQueryString({ ...parseFilters({}), q: "tanglewood" });
    expect(qs).toBe("q=tanglewood");
  });

  it("writes an explicit empty only for what the preset sets", () => {
    const current = parseFilters({ preset: "expiring" });
    const params = new URLSearchParams(toQueryString({ ...current, mine: false }));

    expect(params.get("mine")).toBe("0");
    expect(params.get("state")).toBe("expiring");
    // Never set by this preset, so it should not appear at all.
    expect(params.has("industry")).toBe(false);
    expect(params.has("city")).toBe(false);
  });
});

// ===========================================================================
describe("filters that have nothing to do with a preset", () => {
  it("still round trips a search term", () => {
    const after = roundTrip({ ...parseFilters({}), q: "meridian alloy" });
    expect(after.q).toBe("meridian alloy");
  });

  it("still clears one", () => {
    const withTerm = parseFilters({ q: "meridian" });
    expect(roundTrip({ ...withTerm, q: "" }).q).toBe("");
  });

  it("resets to page one when anything changes", () => {
    // Landing on page 7 of a 2-page result is the classic filtering bug, and it
    // presents as "no results" rather than as a paging problem.
    const after = roundTrip({ ...parseFilters({ page: "7" }), status: "customer", page: 1 });
    expect(after.page).toBe(1);
  });
});
