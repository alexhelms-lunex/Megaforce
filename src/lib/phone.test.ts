import { describe, expect, it } from "vitest";
import { extractExtension, formatPhone, isE164, toE164 } from "./phone";

describe("toE164", () => {
  // The exact requirement from the build plan: these four inputs are the same
  // customer, and every one of them must produce the same match key.
  it("collapses the four common US formats to one value", () => {
    const expected = "+17045551234";
    expect(toE164("+17045551234")).toBe(expected);
    expect(toE164("(704) 555-1234")).toBe(expected);
    expect(toE164("7045551234")).toBe(expected);
    expect(toE164("704-555-1234 x22")).toBe(expected);
  });

  it("strips every extension spelling without corrupting the number", () => {
    const expected = "+17045551234";
    for (const input of [
      "704-555-1234 x22",
      "704-555-1234 X22",
      "704-555-1234 ext 22",
      "704-555-1234 ext. 22",
      "704-555-1234 extension 22",
      "7045551234;ext=22",
      "704.555.1234, 22",
      "+1 (704) 555-1234 ext 4021",
    ]) {
      expect(toE164(input), input).toBe(expected);
    }
  });

  it("does not fold the extension digits into the number", () => {
    // The failure this guards against: stripping punctuation first yields
    // 704555123422, which normalizes to a different, real-looking number.
    expect(toE164("704-555-1234 x22")).not.toBe("+1704555123422");
    expect(toE164("704-555-1234 x22")).toHaveLength(12);
  });

  it("accepts assorted punctuation and whitespace", () => {
    const expected = "+17045551234";
    expect(toE164("  704 555 1234  ")).toBe(expected);
    expect(toE164("704.555.1234")).toBe(expected);
    expect(toE164("+1-704-555-1234")).toBe(expected);
    expect(toE164("1 (704) 555 1234")).toBe(expected);
    expect(toE164("17045551234")).toBe(expected);
  });

  it("unwraps SIP URIs from telephony providers", () => {
    expect(toE164("sip:+17045551234@sip.ringcentral.com")).toBe("+17045551234");
    expect(toE164("sip:7045551234@10.0.0.1")).toBe("+17045551234");
  });

  it("refuses withheld caller ID instead of inventing a number", () => {
    for (const input of ["anonymous", "Anonymous", "UNKNOWN", "restricted", "Private", "blocked"]) {
      expect(toE164(input), input).toBeNull();
    }
  });

  it("refuses empty and unusable input", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("---")).toBeNull();
  });

  it("refuses a 7 digit local number rather than guessing an area code", () => {
    // The same seven digits exist in every area code. Guessing attaches a call
    // to a stranger's account; refusing sends it to the review queue.
    expect(toE164("555-1234")).toBeNull();
    expect(toE164("5551234")).toBeNull();
  });

  it("refuses vanity numbers", () => {
    expect(toE164("1-800-FLOWERS")).toBeNull();
  });

  it("preserves international numbers", () => {
    expect(toE164("+442071838750")).toBe("+442071838750");
    expect(toE164("+61 2 8069 5555")).toBe("+61280695555");
    // "00" is the international access prefix across most of Europe and Asia.
    expect(toE164("00442071838750")).toBe("+442071838750");
  });

  it("respects a non-US default country", () => {
    expect(toE164("+442071838750", "44")).toBe("+442071838750");
    // A bare national number takes the default country's prefix...
    expect(toE164("2071838750", "44")).toBe("+442071838750");
    // ...and is not double-prefixed when the code is already there.
    expect(toE164("442071838750", "44")).toBe("+442071838750");
  });

  it("rejects numbers outside the E.164 length bounds", () => {
    expect(toE164("+1234567")).toBeNull(); // too short
    expect(toE164("+1234567890123456")).toBeNull(); // 16 digits, too long
  });

  it("rejects US numbers of impossible length rather than emitting a foreign one", () => {
    // Guards a specific failure: a truncated US number falling through to the
    // international branch and becoming a valid-looking +7 (Russia) number.
    expect(toE164("70455512")).toBeNull();
    expect(toE164("704555123")).toBeNull();
    expect(toE164("27045551234")).toBeNull(); // 11 digits not led by 1
  });

  it("is idempotent", () => {
    const once = toE164("(704) 555-1234");
    expect(toE164(once)).toBe(once);
  });
});

describe("isE164", () => {
  it("recognises canonical values only", () => {
    expect(isE164("+17045551234")).toBe(true);
    expect(isE164("7045551234")).toBe(false);
    expect(isE164("(704) 555-1234")).toBe(false);
    expect(isE164("+0704555123")).toBe(false); // country code cannot start at 0
    expect(isE164(null)).toBe(false);
  });
});

describe("formatPhone", () => {
  it("renders US numbers the familiar way and leaves others alone", () => {
    expect(formatPhone("+17045551234")).toBe("(704) 555-1234");
    expect(formatPhone("+442071838750")).toBe("+442071838750");
    expect(formatPhone(null)).toBe("");
  });
});

describe("extractExtension", () => {
  it("recovers the extension that toE164 discards", () => {
    expect(extractExtension("704-555-1234 x22")).toBe("22");
    expect(extractExtension("704-555-1234 ext. 4021")).toBe("4021");
    expect(extractExtension("704-555-1234")).toBeNull();
  });
});
