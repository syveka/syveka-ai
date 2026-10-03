/**
 * Error tracking is off unless a DSN is configured. A missing, empty or
 * malformed DSN means "no error tracking": nothing is initialized and
 * nothing is sent. Kept free of SDK imports so the middleware (CSP) can use
 * it without bundling the SDK.
 */
export interface ParsedDsn {
  dsn: string;
  /** The ingest origin events are sent to; the only origin the CSP gains. */
  ingestOrigin: string;
}

export function parseSentryDsn(raw: string | undefined): ParsedDsn | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    // https://<public key>@<host>/<project id>
    if (url.protocol !== "https:" || !url.username || url.password) return null;
    if (!/^\/\d+$/.test(url.pathname) || url.search || url.hash) return null;
    return { dsn: value, ingestOrigin: url.origin };
  } catch {
    return null;
  }
}
