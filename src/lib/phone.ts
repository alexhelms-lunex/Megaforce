/**
 * Phone normalization.
 *
 * Every phone number entering the system -- typed by a rep, imported from a
 * spreadsheet, or lifted off a telephony webhook -- is reduced to one canonical
 * E.164 string before it is stored or compared. Mixed formats are the single
 * most common reason a call fails to log: the contact holds "(704) 555-1234"
 * and the provider sends "+17045551234", and a string comparison finds nothing.
 *
 * The rule enforced here: normalize on WRITE, never on read. A query that has to
 * normalize before comparing cannot use the index on contacts.phone_e164, and
 * that turns matching into a full table scan on every inbound call.
 */

/**
 * Caller ID values that are text, not numbers. A provider sends these when the
 * caller withheld their number. They must never be normalized into something
 * that could match a contact.
 */
const NON_NUMBERS = new Set([
  "anonymous",
  "unknown",
  "restricted",
  "private",
  "blocked",
  "unavailable",
  "withheld",
  "conference",
  "voicemail",
]);

/**
 * Trailing extension in any of the shapes seen in the wild:
 *   "555-1234 x22"      "555-1234 ext 22"     "555-1234 ext. 22"
 *   "555-1234, 22"      "5551234;ext=22"      "5551234 extension 22"
 *
 * Stripped BEFORE digits are extracted. Reversing that order turns
 * "704-555-1234 x22" into the twelve digits 704555123422, which normalizes to a
 * completely different number -- a silent mismatch rather than a loud failure.
 */
const EXTENSION = /(?:[;,]?\s*(?:x|ext|ext\.|extn|extension)\s*[:.=]?\s*\d{1,7}|[;,]\s*\d{1,7})\s*$/i;

/** RingCentral and other SIP-aware providers send "sip:+17045551234@host". */
const SIP_URI = /^(?:sips?:)?([^@]+)@.*$/i;

const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * Reduce arbitrary phone input to E.164, or null when it cannot be used as a
 * match key.
 *
 * Returning null rather than a best guess is deliberate. A wrong normalization
 * attaches a call to the wrong customer's account, which is worse than the call
 * landing in the review queue.
 *
 * @param input     raw phone value, any format
 * @param defaultCountryCode  applied to bare national numbers. Defaults to US.
 */
export function toE164(input: string | null | undefined, defaultCountryCode = "1"): string | null {
  if (!input) return null;

  let raw = String(input).trim();
  if (!raw) return null;

  // "sip:+17045551234@sip.ringcentral.com" -> "+17045551234"
  const sip = raw.match(SIP_URI);
  if (sip) raw = sip[1].trim();

  if (NON_NUMBERS.has(raw.toLowerCase())) return null;

  raw = raw.replace(EXTENSION, "").trim();
  if (!raw) return null;

  // Reject anything containing letters at this point. Vanity numbers
  // ("1-800-FLOWERS") are real but are not a reliable match key, and letters
  // usually signal a status string we failed to recognise above.
  if (/[a-z]/i.test(raw)) return null;

  // Remember an explicit international marker before punctuation is discarded.
  // "00" is the international access prefix used across most of Europe/Asia.
  const explicitlyInternational = raw.startsWith("+") || /^00\d/.test(raw);

  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (raw.startsWith("+")) {
    // Already E.164-shaped. Trust the country code as given.
    return withinRange(digits) ? `+${digits}` : null;
  }

  if (explicitlyInternational) {
    digits = digits.replace(/^00/, "");
    return withinRange(digits) ? `+${digits}` : null;
  }

  // --- No country code supplied. Interpret against the default country. ---

  const cc = defaultCountryCode.replace(/\D/g, "");

  // Seven digits or fewer is a local number with the area code omitted. The
  // same seven digits exist in every area code, so it is genuinely ambiguous.
  // Refused rather than guessed at: a wrong guess files the call against a
  // stranger's account, a refusal files it in the review queue.
  if (digits.length <= 7) return null;

  // The North American Numbering Plan gets exact handling, because it is the
  // plan this system actually runs against.
  if (cc === "1") {
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    // 8, 9, or 11-digits-not-starting-with-1 is malformed here. Falling through
    // would emit things like "+70455512" -- a syntactically valid Russian
    // number built out of a truncated US one.
    if (digits.length < 12) return null;
    // Twelve or more digits is a full international number that simply arrived
    // without its plus sign.
    return withinRange(digits) ? `+${digits}` : null;
  }

  // Non-NANP default. If the digits already lead with the country code and are
  // long enough to carry a national number behind it, take them as complete.
  if (digits.startsWith(cc) && digits.length > cc.length + 6 && withinRange(digits)) {
    return `+${digits}`;
  }

  // Otherwise this is a bare national number; the default country supplies the
  // missing prefix.
  //
  // Note the limitation: without a numbering-plan database, "is this country
  // code already present" cannot always be answered. For real multi-country
  // deployments, swap this branch for libphonenumber-js. The interface does not
  // change.
  return withinRange(cc + digits) ? `+${cc}${digits}` : null;
}

function withinRange(digits: string): boolean {
  return digits.length >= MIN_E164_DIGITS && digits.length <= MAX_E164_DIGITS;
}

/** True when the string is already canonical E.164. */
export function isE164(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * Human-readable rendering for the UI. Storage stays E.164; only display
 * changes. US numbers get the familiar grouping, everything else is left in
 * E.164 rather than guessed at with the wrong national convention.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const us = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
  return e164;
}

/**
 * Pull the extension back out, when one was present. Stored separately from the
 * match key so a direct-dial extension is not lost on import.
 */
export function extractExtension(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).match(EXTENSION);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  return digits || null;
}
