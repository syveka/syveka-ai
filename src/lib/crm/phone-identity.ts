/**
 * Which CRM contact a caller's phone number identifies. Used by the post-call
 * job to link a call to an existing contact instead of creating a duplicate.
 *
 * Contact phones are free text typed by people ("+358 40-123 4567",
 * "(040) 1234567"), while a caller number arrives from the telephony provider,
 * normally in E.164 ("+358401234567"). Two numbers are treated as the same
 * caller only when that is certain without knowing any country:
 * - formatting is ignored: spaces (incl. non-breaking), dots, dashes,
 *   slashes and parentheses;
 * - an international number matches the same digits written with "+" or with
 *   the "00" international prefix;
 * - a number with no international prefix ("0401234567") matches only the
 *   same digits with no prefix. Turning it into an international number needs
 *   the caller's country and its trunk prefix, which a number alone doesn't
 *   give, so "040 1234567" and "+358 40 1234567" stay different contacts.
 *
 * Anything else (empty, "anonymous", a SIP address, an extension, letters, too
 * short or too long) identifies no one: no contact is matched or created.
 *
 * Pure: shared by the job and its tests. Nothing here rewrites stored data.
 */

/** The formatting characters ignored when comparing numbers. */
const NBSP = String.fromCharCode(0xa0);
const SEPARATOR_CHARS = ` \t\n\r\f\v${NBSP}()./-`;

const SEPARATORS = new RegExp(`[${SEPARATOR_CHARS.replace(/[-\\\]^]/g, "\\$&")}]`, "g");

/**
 * The same character class for Postgres `regexp_replace`, passed as a query
 * parameter. Literal characters only (no escapes) so it means the same in
 * both engines; "-" is last, so it is literal.
 */
export const PHONE_SEPARATOR_SQL_PATTERN = `[${SEPARATOR_CHARS}]`;

/** E.164: "+", a country code that doesn't start with 0, 7 to 15 digits in all. */
const E164_DIGITS = /^[1-9]\d{6,14}$/;
/** A number with no international prefix, as some trunks send it. */
const UNQUALIFIED_DIGITS = /^\d{4,15}$/;

export type CallerPhoneIdentity = {
  /** International (certain) or with no international prefix (exact digits only). */
  kind: "international" | "unqualified";
  /** Stored on a contact created for this caller; also the lock key. */
  canonical: string;
  /** Stored phones, with formatting removed, that are this same number. */
  matchForms: string[];
};

/** A phone number with its formatting characters removed. */
export function compactPhone(value: string): string {
  return value.replace(SEPARATORS, "");
}

/** The identity a caller number establishes, or null when it identifies no one. */
export function callerPhoneIdentity(
  callerNumber: string | null | undefined,
): CallerPhoneIdentity | null {
  if (!callerNumber) return null;
  const compact = compactPhone(callerNumber);

  const international = compact.startsWith("+")
    ? compact.slice(1)
    : compact.startsWith("00")
      ? compact.slice(2)
      : null;
  if (international !== null) {
    if (!E164_DIGITS.test(international)) return null;
    return {
      kind: "international",
      canonical: `+${international}`,
      matchForms: [`+${international}`, `00${international}`],
    };
  }
  if (UNQUALIFIED_DIGITS.test(compact)) {
    return { kind: "unqualified", canonical: compact, matchForms: [compact] };
  }
  return null;
}
