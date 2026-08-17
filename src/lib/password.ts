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
 * Length dominates, because it does. The character-class bonuses are small on
 * purpose: a meter that rewards them heavily teaches people to add a "!" rather
 * than another word, which is the wrong lesson.
 */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!password) return { score: 0, label: "" };
  if (password.length < MIN_PASSWORD_LENGTH) return { score: 0, label: "Too short" };

  let points = 0;
  if (password.length >= 16) points += 1;
  if (password.length >= 24) points += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 1;
  if (/\d/.test(password)) points += 1;
  if (/[^\w\s]/.test(password)) points += 1;
  if (/\s/.test(password)) points += 1; // a passphrase

  if (points >= 4) return { score: 3, label: "Strong" };
  if (points >= 2) return { score: 2, label: "Good" };
  return { score: 1, label: "Acceptable" };
}
