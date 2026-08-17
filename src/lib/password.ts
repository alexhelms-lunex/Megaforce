/**
 * What a new password has to be.
 *
 * A plain module, not part of the reset action's file. A "use server" file may
 * export async functions and NOTHING else -- a helper exported from one takes
 * the whole module down at runtime, and takes every button on every page with
 * it if that module is reachable from the shell. That has already happened once
 * in this project and cost several days.
 *
 * ---------------------------------------------------------------------------
 * Length first, and by a distance. Every other rule below is a tie-breaker
 * against the handful of passwords people reach for when a form demands a
 * capital letter, and none of them is worth much next to twelve characters.
 *
 * Deliberately NOT a symbol requirement. It reliably produces "Password1!" and
 * very little else, while making a genuinely strong passphrase harder to type.
 * ---------------------------------------------------------------------------
 */

export const MIN_PASSWORD_LENGTH = 12;

const COMMON = [
  "password",
  "12345678",
  "qwerty",
  "letmein",
  "welcome",
  "megaforce",
  "changeme",
  "iloveyou",
  "admin123",
  "111111",
];

/** The problem with this password, or null if there is not one. */
export function checkPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return (
      `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you will remember ` +
      `beats a short word you will not.`
    );
  }
  if (password.length > 200) return "That is longer than the login service accepts.";

  const lowered = password.toLowerCase();
  if (COMMON.some((c) => lowered.includes(c))) {
    return "That contains a very common password. Pick something else.";
  }
  if (/^(.)\1+$/.test(password)) return "That is one character repeated. Pick something else.";

  return null;
}

/**
 * A rough strength reading for the meter on the form.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES, AND BOTH WERE WRONG IN THE FIRST VERSION.
 *
 * 1. It must never rate anything acceptable that checkPassword refuses.
 *    The first version scored "Password1234" as Good -- twelve characters, a
 *    capital and four digits -- while the form rejected it as a common
 *    password. A meter that encourages a password the submit button will
 *    refuse is worse than no meter.
 *
 * 2. Length has to dominate, visibly.
 *    The first version scored a 28-character passphrase the same as a
 *    12-character string of symbols, because it paid a point per character
 *    class and only two for length. That teaches people to add a "!" rather
 *    than another word, which is the wrong lesson and the more common one.
 *
 * So length sets the score and variety can lift it by one. Nothing can be
 * rated at all until it passes the rules the form actually enforces.
 * ---------------------------------------------------------------------------
 */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!password) return { score: 0, label: "" };
  if (password.length < MIN_PASSWORD_LENGTH) return { score: 0, label: "Too short" };

  // The form's own rules first. Anything they refuse is not "weak", it is
  // unusable, and the meter must not suggest otherwise.
  if (checkPassword(password) !== null) return { score: 0, label: "Too weak" };

  let score = password.length >= 24 ? 3 : password.length >= 16 ? 2 : 1;

  // One point for variety, whichever kind. Capped, so it can lift a shortish
  // password by a step but never carry one on its own.
  const classes =
    Number(/[a-z]/.test(password) && /[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^\w\s]/.test(password)) +
    Number(/\s/.test(password));
  if (classes >= 2 && score < 3) score += 1;

  const label = score >= 3 ? "Strong" : score === 2 ? "Good" : "Acceptable";
  return { score: score as 1 | 2 | 3, label };
}
