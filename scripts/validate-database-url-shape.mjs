#!/usr/bin/env node
/**
 * Standalone, dependency-free shape validator for a Postgres/Supabase
 * connection-string env var. Built after staging run 33961238272 failed
 * with `FATAL: database "postgres\n" does not exist` -- a trailing newline
 * embedded in the STAGING_DIRECT_URL secret's stored value, which none of
 * scripts/validate-staging-config.mjs's existing "identity" mode checks
 * would have caught (it checks project-ref presence and rejects port 6543,
 * but never inspects the raw string for stray whitespace, nor the database
 * path segment at all).
 *
 * Never reads a value that isn't already in this process's own environment,
 * never prints the raw URL or password, and takes no dependencies -- safe to
 * run as an early CI step, or by a human locally before pasting a candidate
 * value into a GitHub secret.
 *
 * Usage:
 *   node scripts/validate-database-url-shape.mjs <ENV_VAR_NAME> [--expect-ref=<ref>] [--forbid-ref=<ref>]
 */

function redactRef(ref) {
  if (!ref) return "(none)";
  return ref.length <= 6 ? `${ref}...` : `${ref.slice(0, 6)}...`;
}

function redactUser(user) {
  const dotIndex = user.indexOf(".");
  if (dotIndex === -1) return user;
  return `${user.slice(0, dotIndex)}.${redactRef(user.slice(dotIndex + 1))}`;
}

/**
 * @param {string} rawValue the exact, unmodified env var value
 * @param {{ expectedProjectRef?: string, forbiddenProjectRef?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], redacted: Record<string, string> }}
 */
export function validateDatabaseUrlShape(rawValue, options = {}) {
  const errors = [];
  const redacted = {};

  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return { ok: false, errors: ["value is empty or not a string."], redacted };
  }

  // The exact defect class that caused the staging failure: a stray
  // leading/trailing whitespace or control character (most commonly a
  // trailing newline from how the secret was originally set, e.g.
  // `cat file | gh secret set NAME` where the file had a trailing newline)
  // becomes part of the last URL path segment -- the database name -- once
  // interpolated into a shell env var and handed to psql/libpq as a single
  // connection string.
  if (rawValue !== rawValue.trim()) {
    errors.push(
      "value has leading or trailing whitespace/newline -- this is exactly what caused " +
        'staging run 33961238272 to fail with `FATAL: database "postgres\\n" does not exist`. ' +
        "Re-set the secret with a trimmed value (verify with `printf '%s' \"$VALUE\" | xxd | tail -3`" +
        " locally before pasting into GitHub -- a text editor or `cat file |` pipeline often " +
        "appends a trailing newline invisibly).",
    );
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(rawValue)) {
    errors.push("value contains an embedded control character other than a trimmable newline.");
  }

  let parsed;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    errors.push("value is not a parseable URL (checked against the trimmed value).");
    return { ok: false, errors, redacted };
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    errors.push(`protocol must be postgresql:// or postgres://, got ${parsed.protocol}`);
  }

  const database = parsed.pathname.replace(/^\//, "");
  redacted.host = parsed.hostname;
  redacted.port = parsed.port || "(default)";
  redacted.database = database;
  redacted.user = redactUser(parsed.username);
  redacted["password-present"] = parsed.password.length > 0 ? "yes" : "no";

  if (!parsed.password) {
    errors.push("password is empty.");
  }
  if (database !== "postgres") {
    errors.push(`database path must be exactly "postgres", got "${database}".`);
  }

  const isDirectHost = /^db\.[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname);
  const isPoolerHost = /\.pooler\.supabase\.com$/.test(parsed.hostname);

  let projectRef = null;
  if (isDirectHost) {
    projectRef = parsed.hostname.slice("db.".length, "db.".length + 20);
    if (parsed.username !== "postgres") {
      errors.push(
        `direct-host connections use the plain username "postgres", got "${redactUser(parsed.username)}".`,
      );
    }
    if (parsed.port && parsed.port !== "5432") {
      errors.push(`direct-host connections use port 5432, got ${parsed.port}.`);
    }
  } else if (isPoolerHost) {
    const match = /^postgres\.([a-z0-9]{20})$/.exec(parsed.username);
    if (!match) {
      errors.push(
        'pooler-host connections require a Supavisor-format username "postgres.<20-char-project-ref>"' +
          ` (Supabase's Session/Transaction pooler modes), got "${redactUser(parsed.username)}".` +
          ' A bare "postgres" username here is a common misconfiguration.',
      );
    } else {
      projectRef = match[1];
    }
    if (parsed.port !== "5432" && parsed.port !== "6543") {
      errors.push(
        `pooler-host connections use port 5432 (session) or 6543 (transaction), got ${parsed.port}.`,
      );
    } else if (parsed.port === "6543") {
      errors.push(
        "port 6543 is the transaction pooler, which does not support the prepared statements " +
          "Prisma migrations and most raw psql session use need -- use the session pooler (5432) " +
          "or the direct host instead.",
      );
    }
  } else {
    errors.push(
      `host "${parsed.hostname}" matches neither a direct Supabase host (db.<ref>.supabase.co) ` +
        "nor a pooler host (*.pooler.supabase.com).",
    );
  }

  redacted["project-ref"] = redactRef(projectRef);

  if (projectRef && options.expectedProjectRef && projectRef !== options.expectedProjectRef) {
    errors.push(
      `project ref does not match the expected staging project ref (got ${redactRef(projectRef)}).`,
    );
  }
  if (projectRef && options.forbiddenProjectRef && projectRef === options.forbiddenProjectRef) {
    errors.push("project ref matches the forbidden (production) project ref.");
  }

  return { ok: errors.length === 0, errors, redacted };
}

async function main() {
  const [varName, ...rest] = process.argv.slice(2);
  if (!varName) {
    console.error(
      "Usage: node scripts/validate-database-url-shape.mjs <ENV_VAR_NAME> [--expect-ref=x] [--forbid-ref=y]",
    );
    process.exit(2);
  }

  const options = {};
  for (const arg of rest) {
    const expectMatch = /^--expect-ref=(.+)$/.exec(arg);
    const forbidMatch = /^--forbid-ref=(.+)$/.exec(arg);
    if (expectMatch) options.expectedProjectRef = expectMatch[1];
    else if (forbidMatch) options.forbiddenProjectRef = forbidMatch[1];
  }

  const rawValue = process.env[varName];
  if (rawValue === undefined) {
    console.error(`${varName} is not set.`);
    process.exit(2);
  }

  const { ok, errors, redacted } = validateDatabaseUrlShape(rawValue, options);

  for (const [key, value] of Object.entries(redacted)) {
    console.log(`${key}=${value}`);
  }

  if (!ok) {
    console.error(`\n${varName} failed shape validation:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(`\n${varName} passed shape validation.`);
}

if (process.argv[1] && process.argv[1].endsWith("validate-database-url-shape.mjs")) {
  main();
}
