// Fail-closed guard: production's DATABASE_URL must be Supabase's
// transaction-mode pooler (port 6543), never the session-mode pooler or a
// direct connection. This mirrors the staging incident documented in
// docs/staging-database-url-pooler-fix.md and src/server/db/connection-
// string-sanitizer.ts's ensurePgbouncerCompatibility(): a Next.js app on
// Vercel opens one connection per concurrent serverless invocation, and
// only the transaction pooler is designed for many short-lived concurrent
// connections. Session mode / a direct connection has a low, fixed
// connection cap that concurrent production traffic will exhaust, causing
// PrismaClientInitializationError ("FATAL: (EMAXCONNSESSION) max clients
// reached in session mode"). This must fail BEFORE any migration or deploy
// step touches the database, not surface later as an intermittent outage.
//
// Deliberately narrow: this checks exactly one thing (DATABASE_URL's port),
// nothing else about production configuration. Never reads or logs the
// connection string itself -- only its port, and only after a successful
// parse (a raw `new URL()` throw can embed the input value in its own
// message/stack, so any parse failure is reported by field name only,
// never by re-throwing or interpolating the caught error).

function parseDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw?.trim()) {
    throw new Error("DATABASE_URL is not set.");
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
}

export function validateProductionDatabasePooler(url = parseDatabaseUrl()) {
  if (url.port !== "6543") {
    throw new Error(
      `DATABASE_URL uses port ${url.port || "5432"}, not Supabase's transaction-mode pooler ` +
        "port 6543 -- production needs the transaction pooler for concurrent serverless " +
        "request handling. Session mode / a direct connection has a low, fixed connection " +
        "cap that concurrent traffic exhausts, causing intermittent " +
        "PrismaClientInitializationError failures. Use the direct connection for DIRECT_URL/" +
        "migrations only, never for the app's own DATABASE_URL.",
    );
  }
  console.log("DATABASE_URL uses the transaction-mode pooler (port 6543), as required.");
}

if (process.argv[1]?.endsWith("validate-production-database-pooler.mjs")) {
  validateProductionDatabasePooler();
}
