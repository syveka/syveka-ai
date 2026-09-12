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

/**
 * Supabase's transaction-mode pooler (port 6543) multiplexes different
 * client sessions onto the same underlying Postgres backend connection
 * between transactions. Prisma's default behavior — native PostgreSQL
 * prepared statements, cached by name on the client side — is incompatible
 * with that: a statement prepared under one logical session can get bound
 * with a different query's parameters after the pooler reassigns the
 * backend connection, surfacing as a raw Postgres protocol error ("bind
 * message supplies N parameters, but prepared statement requires M").
 * Confirmed live on staging (2026-09-12), immediately after switching
 * DATABASE_URL to the transaction pooler to fix a separate EMAXCONNSESSION
 * connection-exhaustion outage. Prisma's own docs require `pgbouncer=true`
 * (and recommend `connection_limit=1` alongside it for serverless, so each
 * function instance doesn't itself hold more than one connection into the
 * already-multiplexed pool) whenever the datasource is a transaction-mode
 * pooler. This enforces both defensively, so a future connection-string
 * rotation that omits them can't reintroduce the same outage — it never
 * needs to know or log the credentials, only the port and query string.
 */
export function ensurePgbouncerCompatibility(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.port !== "6543") return raw;

  if (!url.searchParams.has("pgbouncer")) url.searchParams.set("pgbouncer", "true");
  if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "1");
  return url.toString();
}
