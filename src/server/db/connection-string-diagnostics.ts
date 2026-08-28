/**
 * TEMPORARY staging-only diagnostic (2026-08-28) for the DATABASE_URL/DIRECT_URL
 * malformed-connection-string investigation. Reports only structural metadata
 * that is safe to log per the investigation's explicit safe-list — never the
 * password, never the full connection string. Remove once the root cause is
 * confirmed and fixed.
 */
export type DbUrlShape = {
  parsed: boolean;
  protocol?: string;
  hostClass?: "transaction-pooler" | "session-pooler" | "direct" | "unknown";
  port?: string;
  hasDatabaseName: boolean;
  usernameLooksLikeSupabasePooled: boolean;
  hasPassword: boolean;
  queryParamNames: string[];
  queryParamCount: number;
  hasLeadingOrTrailingWhitespace: boolean;
  containsNewlineOrCarriageReturn: boolean;
  containsLiteralQuoteChar: boolean;
  questionMarkCount: number;
  parseErrorName?: string;
};

function classifyHost(hostname: string, port: string): DbUrlShape["hostClass"] {
  if (hostname.endsWith(".pooler.supabase.com")) {
    if (port === "6543") return "transaction-pooler";
    if (port === "5432") return "session-pooler";
    return "unknown";
  }
  if (hostname.startsWith("db.") && hostname.endsWith(".supabase.co")) {
    return "direct";
  }
  return "unknown";
}

export function classifyDbUrl(raw: string | undefined): DbUrlShape {
  const hasLeadingOrTrailingWhitespace = raw !== undefined && raw !== raw.trim();
  const containsNewlineOrCarriageReturn = raw !== undefined && /[\r\n]/.test(raw);
  const containsLiteralQuoteChar = raw !== undefined && /['"]/.test(raw);
  const questionMarkCount = raw ? (raw.match(/\?/g) ?? []).length : 0;

  const base = {
    hasLeadingOrTrailingWhitespace,
    containsNewlineOrCarriageReturn,
    containsLiteralQuoteChar,
    questionMarkCount,
  };

  if (!raw) {
    return {
      parsed: false,
      usernameLooksLikeSupabasePooled: false,
      hasPassword: false,
      queryParamNames: [],
      queryParamCount: 0,
      hasDatabaseName: false,
      ...base,
    };
  }

  try {
    const url = new URL(raw.trim());
    const queryParamNames = [...url.searchParams.keys()];

    return {
      parsed: true,
      protocol: url.protocol.replace(":", ""),
      hostClass: classifyHost(url.hostname, url.port),
      port: url.port || "(default)",
      hasDatabaseName: url.pathname.replace(/^\//, "").length > 0,
      usernameLooksLikeSupabasePooled:
        /^postgres\.[a-z0-9]+$/.test(url.username) || url.username === "postgres",
      hasPassword: url.password.length > 0,
      queryParamNames,
      queryParamCount: queryParamNames.length,
      ...base,
    };
  } catch (e) {
    return {
      parsed: false,
      usernameLooksLikeSupabasePooled: false,
      hasPassword: false,
      queryParamNames: [],
      queryParamCount: 0,
      hasDatabaseName: false,
      parseErrorName: e instanceof Error ? e.constructor.name : typeof e,
      ...base,
    };
  }
}

/**
 * Vercel's env var text fields (and copy/paste in general) can silently
 * introduce a trailing newline, surrounding whitespace, or a stray leftover
 * `?` character (e.g. from editing a value in place to append query
 * parameters). The WHATWG URL parser tolerates most of this — it strips
 * embedded tab/newline characters and a trailing bare `?` becomes part of
 * whatever value preceded it rather than a parse failure — but Prisma's own,
 * stricter connection-string parser does not, and rejects the whole string
 * as malformed ("certain characters must be escaped").
 *
 * This normalizes exactly the classes of corruption `classifyDbUrl` above
 * can prove are present (whitespace, embedded CR/LF, a trailing bare `?`)
 * without needing to know or log the secret value itself.
 */
export function sanitizeConnectionString(raw: string): string {
  let value = raw.replace(/[\r\n]/g, "").trim();
  if (value.endsWith("?")) {
    value = value.slice(0, -1);
  }
  return value;
}
