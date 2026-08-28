/**
 * Vercel's env var text fields (and copy/paste in general) can silently
 * introduce a trailing newline, surrounding whitespace, or a stray leftover
 * `?` character (e.g. from editing a value in place to append query
 * parameters). The WHATWG URL parser tolerates most of this — it strips
 * embedded tab/newline characters and a trailing bare `?` becomes part of
 * whatever value preceded it rather than a parse failure — but Prisma's own,
 * stricter connection-string parser does not, and rejects the whole string
 * as malformed ("certain characters must be escaped"). Confirmed live on
 * staging (2026-08-28): DATABASE_URL parsed correctly under a lenient WHATWG
 * URL parse but carried a trailing newline, whitespace, and a stray trailing
 * `?`, which Prisma rejected outright.
 *
 * Normalizes exactly those three proven corruption classes without needing
 * to know or log the secret value itself.
 */
export function sanitizeConnectionString(raw: string): string {
  let value = raw.replace(/[\r\n]/g, "").trim();
  if (value.endsWith("?")) {
    value = value.slice(0, -1);
  }
  return value;
}
