/**
 * Vercel's env var text fields (and copy/paste in general) can silently
 * introduce a trailing newline, surrounding whitespace, a stray leftover `?`
 * character (e.g. from editing a value in place to append query
 * parameters), or matching wrapping quotes (e.g. pasting a value that still
 * has the quotes a dashboard/export tool put around it). The WHATWG URL
 * parser tolerates most whitespace/newline corruption — it strips embedded
 * tab/newline characters, and a trailing bare `?` becomes part of whatever
 * value preceded it rather than a parse failure — but Prisma's own, stricter
 * connection-string parser does not, and rejects the whole string as
 * malformed ("certain characters must be escaped"). Confirmed live on
 * staging (2026-08-28): DATABASE_URL parsed correctly under a lenient WHATWG
 * URL parse but carried a trailing newline, whitespace, and a stray trailing
 * `?`, which Prisma rejected outright. A second, harder failure (staging run
 * 33990035456) showed wrapping quotes can go further and break even the
 * lenient WHATWG parse itself (`new URL()` throws outright, not just Prisma).
 *
 * Normalizes exactly these four proven corruption classes without needing
 * to know or log the secret value itself. Mirrored (not imported, since
 * plain `node`-executed .mjs scripts like validate-staging-config.mjs can't
 * import a .ts file) at scripts/lib/sanitize-connection-string.mjs — keep
 * both in sync.
 */
export function sanitizeConnectionString(raw: string): string {
  let value = raw.replace(/[\r\n]/g, "").trim();
  if (value.endsWith("?")) {
    value = value.slice(0, -1);
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}
