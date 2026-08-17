import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, checkPassword, passwordStrength } from "./password";

/**
 * The rules on a new password.
 *
 * ---------------------------------------------------------------------------
 * Worth testing for a reason that is not obvious: these rules run in two places
 * -- in the browser as somebody types, and on the server when they submit --
 * and the server copy is the one that decides. If they disagree, the form
 * either accepts something the server will refuse (a submit that fails with no
 * explanation next to the field) or refuses something the server would accept
 * (a password somebody cannot use, with no way to find out why).
 *
 * One function, imported by both, and a test that pins its behaviour.
 * ---------------------------------------------------------------------------
 */

describe("what a password has to be", () => {
  it("accepts a passphrase", () => {
    expect(checkPassword("stapler cobalt harbour")).toBeNull();
  });

  it("accepts a long random string", () => {
    expect(checkPassword("Tq7#vLm2Xz9!bR4w")).toBeNull();
  });

  it("refuses anything under the minimum, however clever", () => {
    expect(checkPassword("Tq7#vLm2")).toMatch(new RegExp(String(MIN_PASSWORD_LENGTH)));
    expect(checkPassword("")).toBeTruthy();
  });

  it("refuses the passwords everybody reaches for", () => {
    // Length alone would let all of these through, which is the whole reason
    // the list exists: "Password1234" is twelve characters.
    for (const bad of ["Password1234", "qwerty123456", "letmein123456", "megaforce2026"]) {
      expect(checkPassword(bad), bad).toBeTruthy();
    }
  });

  it("refuses one character held down", () => {
    expect(checkPassword("aaaaaaaaaaaaaaaa")).toBeTruthy();
  });

  it("refuses something longer than the login service accepts", () => {
    expect(checkPassword("x".repeat(300))).toMatch(/longer than/i);
  });

  /*
   * Deliberately NOT a symbol requirement.
   *
   * A symbol rule reliably produces "Password1!" and very little else, while
   * making a genuinely strong passphrase harder to type. This test exists so
   * that reintroducing one is a decision somebody makes on purpose rather than
   * a tweak that slips in.
   */
  it("does not demand a symbol", () => {
    expect(checkPassword("correct horse battery staple")).toBeNull();
  });
});

describe("the strength meter", () => {
  it("says nothing about an empty box", () => {
    expect(passwordStrength("").score).toBe(0);
  });

  it("calls anything too short too short", () => {
    expect(passwordStrength("short").label).toBe("Too short");
  });

  it("rates a long passphrase above a short complicated one", () => {
    const phrase = passwordStrength("stapler cobalt harbour ember");
    const gnarly = passwordStrength("Tq7#vLm2Xz9!");
    expect(phrase.score).toBeGreaterThan(gnarly.score);
  });

  it("never rates anything acceptable that checkPassword refuses", () => {
    // The two must agree, or the meter encourages a password the form rejects.
    for (const bad of ["short", "Password1234", "aaaaaaaaaaaa"]) {
      if (checkPassword(bad) !== null) {
        expect(passwordStrength(bad).score, bad).toBeLessThanOrEqual(1);
      }
    }
  });
});
