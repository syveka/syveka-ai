/**
 * Sanitized description of the database connection a Prisma client is built
 * with, logged once per client initialization (so once per serverless
 * instance that initializes one, not once per deployment).
 *
 * The production runtime DATABASE_URL is a Vercel Sensitive variable that
 * nobody can read back, so this is the only way to learn which kind of
 * endpoint the deployed build actually uses. It reports categories only:
 * never the connection string, credentials, username, hostname, project ref,
 * query-string values or parser errors.
 *
 * Endpoint formats (Supabase, "Connecting to Postgres"):
 * - direct:           db.<ref>.supabase.co:5432
 * - dedicated pooler: db.<ref>.supabase.co:6543 (transaction mode only)
 * - shared pooler:    aws-<n>-<region>.pooler.supabase.com, user postgres.<ref>,
 *                     port 5432 = session mode, 6543 = transaction mode
 * Anything else, including a missing port, is reported as unknown.
 */

export type EndpointCategory = "direct" | "shared_pooler" | "dedicated_pooler" | "unknown";
export type ConnectionMode = "transaction" | "session" | "unknown";
export type ProjectMatch = "yes" | "no" | "unknown";

export interface ConnectionDiagnostic {
  variablePresent: boolean;
  endpointCategory: EndpointCategory;
  port: number | "unknown";
  connectionMode: ConnectionMode;
  expectedProjectMatch: ProjectMatch;
  sslmodeParamPresent: boolean | "unknown";
}

export interface DiagnosticContext {
  /** NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl?: string;
  /** The project ref this deployment is expected to use (production's, for a production build). */
  expectedProjectRef?: string;
}

const PROJECT_REF = /^[a-z0-9]{20}$/;
const DB_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const SHARED_POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const SUPABASE_API_HOST = /^([a-z0-9]{20})\.supabase\.co$/;

const UNKNOWN_ENDPOINT = {
  endpointCategory: "unknown",
  port: "unknown",
  connectionMode: "unknown",
} as const;

function parse(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function refFromPoolerUser(rawUsername: string): string | undefined {
  let username: string;
  try {
    username = decodeURIComponent(rawUsername);
  } catch {
    return undefined;
  }
  const dot = username.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ref = username.slice(dot + 1);
  return PROJECT_REF.test(ref) ? ref : undefined;
}

function refFromSupabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = parse(value.trim());
  return url ? url.hostname.match(SUPABASE_API_HOST)?.[1] : undefined;
}

function projectMatch(
  databaseRef: string | undefined,
  supabaseUrlRef: string | undefined,
  expectedRef: string | undefined,
): ProjectMatch {
  // Two variables agreeing with each other doesn't show they point at the
  // intended project, so both are compared with the expected ref.
  if (!expectedRef || !PROJECT_REF.test(expectedRef)) return "unknown";
  const known = [databaseRef, supabaseUrlRef].filter((ref) => ref !== undefined);
  if (known.some((ref) => ref !== expectedRef)) return "no";
  return databaseRef === expectedRef && supabaseUrlRef === expectedRef ? "yes" : "unknown";
}

export function describeConnection(
  connectionString: string | undefined,
  context: DiagnosticContext,
): ConnectionDiagnostic {
  if (!connectionString) {
    return {
      variablePresent: false,
      ...UNKNOWN_ENDPOINT,
      expectedProjectMatch: "unknown",
      sslmodeParamPresent: "unknown",
    };
  }

  const url = parse(connectionString);
  if (!url || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    return {
      variablePresent: true,
      ...UNKNOWN_ENDPOINT,
      expectedProjectMatch: "unknown",
      sslmodeParamPresent: "unknown",
    };
  }

  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : undefined;
  let endpointCategory: EndpointCategory = "unknown";
  let connectionMode: ConnectionMode = "unknown";
  let databaseRef: string | undefined;

  const dbHostRef = host.match(DB_HOST)?.[1];
  if (dbHostRef) {
    databaseRef = dbHostRef;
    if (port === 5432) {
      endpointCategory = "direct";
      connectionMode = "session";
    } else if (port === 6543) {
      endpointCategory = "dedicated_pooler";
      connectionMode = "transaction";
    }
  } else if (SHARED_POOLER_HOST.test(host)) {
    endpointCategory = "shared_pooler";
    databaseRef = refFromPoolerUser(url.username);
    if (port === 5432) connectionMode = "session";
    else if (port === 6543) connectionMode = "transaction";
  }

  return {
    variablePresent: true,
    endpointCategory,
    port: port ?? "unknown",
    connectionMode,
    expectedProjectMatch: projectMatch(
      databaseRef,
      refFromSupabaseUrl(context.supabaseUrl),
      context.expectedProjectRef?.trim(),
    ),
    sslmodeParamPresent: url.searchParams.has("sslmode"),
  };
}

/**
 * Logs the sanitized description. Never throws: a diagnostic failure must not
 * affect database initialization.
 */
export function logConnectionDiagnostic(connectionString: string | undefined): void {
  try {
    const diagnostic = describeConnection(connectionString, {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      // Inlined at build time. For production it is set by the build step from
      // the repository variable PRODUCTION_SUPABASE_PROJECT_REF; when absent,
      // the match is reported as unknown.
      expectedProjectRef: process.env.NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF,
    });
    console.info(JSON.stringify({ event: "db_connection_diagnostic", ...diagnostic }));
  } catch {
    // Intentionally silent: a raw error here could carry parts of the value.
  }
}
