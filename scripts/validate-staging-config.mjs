import { createHash } from "node:crypto";
import { sanitizeConnectionString } from "./lib/sanitize-connection-string.mjs";

const mode = process.env.STAGING_CONFIG_MODE;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Staging run 33997427716: DATABASE_URL failed with `length=11; missing
// "://" scheme separator` -- clean-shaped (no whitespace/quote corruption
// detected), so a literal, complete, wrong string, not formatting noise.
// Confirmed by direct, redacted local inspection (never printed): the value
// is exactly the 11-character literal "[SENSITIVE]" -- Vercel's own
// placeholder for a variable marked as a "Sensitive Environment Variable".
// Sensitive variables ARE injected into the deployed app at runtime, but
// their value can never be read back afterward by `vercel pull`/the CLI/the
// API/the dashboard, by design -- no code fix can make an intentionally
// unreadable value readable. DATABASE_URL, DIRECT_URL, and (confirmed
// separately) SUPABASE_SERVICE_ROLE_KEY are all marked Sensitive in this
// project's Preview environment; a human must un-mark that flag in the
// Vercel dashboard (Project → Settings → Environment Variables) for this
// runtime cross-check to ever see a real value again.
//
// Never print or log the raw value to find out what it is -- compare its
// hash against known literal placeholders instead. A hash match proves
// exactly which one without ever revealing the value; no match at least
// rules all of them out for the next round of investigation.
const KNOWN_PLACEHOLDER_HASHES = new Map(
  [
    "[SENSITIVE]",
    "postgresql:",
    "placeholder",
    "example.com",
    "DATABASE_URL",
    "your-database",
    "REPLACE_ME",
    "changeme",
    "TODO",
    "",
  ].map((candidate) => [
    sha256(candidate),
    candidate.length === 0 ? "(empty string)" : `"${candidate}"`,
  ]),
);

function requireSettings(names) {
  for (const name of names) {
    if (!process.env[name]?.trim()) {
      throw new Error(`Missing required staging-only setting: ${name}`);
    }
  }
}

function requireProjectRef(projectRef) {
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error("STAGING_SUPABASE_PROJECT_REF must be a 20-character Supabase project ref.");
  }
}

// `new URL()` throws a native TypeError whose `input` property (and
// stack-trace-adjacent output) contains the raw value it failed to parse.
// For these settings that raw value is a connection string or Supabase URL,
// so an unwrapped `new URL()` call risks printing it straight into the CI
// log. Always go through this helper instead, which reports only the field
// name that failed.
//
// Sanitizes before parsing (staging run 33961238272: trailing newline in
// STAGING_DIRECT_URL, invisible to Prisma's stricter parser but reaching
// psql unsanitized here too; staging run 33990035456: Vercel Preview's
// pulled DATABASE_URL failed even this lenient WHATWG parse outright,
// consistent with quote-wrapping -- see connection-string-sanitizer.ts). If
// sanitizing doesn't fix it, the diagnostic below reports safe, derived
// structural facts only (never a substring of the raw value) so a future
// failure of this kind doesn't need another blind round-trip to diagnose.
function parseUrl(name) {
  const raw = process.env[name] ?? "";
  const sanitized = sanitizeConnectionString(raw);
  try {
    return new URL(sanitized);
  } catch {
    const facts = [`length=${raw.length}`];
    if (raw !== sanitized)
      facts.push(
        "whitespace/newline/quote-wrapping was present and stripped, but parsing still failed",
      );
    if (!/:\/\//.test(sanitized)) facts.push('missing "://" scheme separator');
    if (/^['"]/.test(sanitized) || /['"]$/.test(sanitized))
      facts.push("still has an unmatched leading or trailing quote character");
    if (/[\x00-\x1f]/.test(sanitized))
      facts.push("still contains a control character after sanitization");
    const knownPlaceholder = KNOWN_PLACEHOLDER_HASHES.get(sha256(raw));
    if (knownPlaceholder) {
      facts.push(`value is exactly the known literal placeholder ${knownPlaceholder}`);
      if (knownPlaceholder === '"[SENSITIVE]"') {
        facts.push(
          "this is Vercel's own placeholder for a variable marked as a Sensitive Environment " +
            "Variable -- it is injected into the deployed app at runtime but can never be read " +
            "back by vercel pull/CLI/API/dashboard afterward; a human must un-mark the " +
            '"Sensitive" flag on this variable in Vercel (Project -> Settings -> Environment ' +
            "Variables) before this check can see a real value",
        );
      }
    }
    throw new Error(`${name} is not a valid URL. (${facts.join("; ")}.)`);
  }
}

if (mode === "identity") {
  requireSettings([
    "STAGING_SUPABASE_PROJECT_REF",
    "PRODUCTION_SUPABASE_PROJECT_REF",
    "STAGING_SUPABASE_URL",
    "STAGING_DATABASE_URL",
    "STAGING_DIRECT_URL",
  ]);

  const projectRef = process.env.STAGING_SUPABASE_PROJECT_REF;
  requireProjectRef(projectRef);
  if (projectRef === process.env.PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error("Staging validation refused the configured production Supabase project ref.");
  }

  const supabaseUrl = parseUrl("STAGING_SUPABASE_URL");
  if (supabaseUrl.hostname !== `${projectRef}.supabase.co`) {
    throw new Error("STAGING_SUPABASE_URL does not match STAGING_SUPABASE_PROJECT_REF.");
  }

  for (const name of ["STAGING_DATABASE_URL", "STAGING_DIRECT_URL"]) {
    const databaseUrl = parseUrl(name);
    const identifiesProject =
      databaseUrl.hostname.includes(projectRef) || databaseUrl.username.includes(projectRef);
    if (!identifiesProject) {
      throw new Error(`${name} does not identify the staging Supabase project ref.`);
    }
  }

  if (process.env.STAGING_DIRECT_URL.includes(":6543/")) {
    throw new Error("STAGING_DIRECT_URL appears to use the transaction pooler port 6543.");
  }

  console.log("Staging Supabase project identity is valid.");
} else if (mode === "storage") {
  requireSettings([
    "STAGING_SUPABASE_PROJECT_REF",
    "STAGING_SUPABASE_URL",
    "STAGING_SUPABASE_SERVICE_ROLE_KEY",
  ]);
  const projectRef = process.env.STAGING_SUPABASE_PROJECT_REF;
  requireProjectRef(projectRef);
  const supabaseUrl = parseUrl("STAGING_SUPABASE_URL");
  if (supabaseUrl.hostname !== `${projectRef}.supabase.co`) {
    throw new Error("STAGING_SUPABASE_URL does not match STAGING_SUPABASE_PROJECT_REF.");
  }

  const response = await fetch(`${supabaseUrl.origin}/storage/v1/bucket/documents`, {
    headers: {
      apikey: process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to verify the staging documents bucket (HTTP ${response.status}).`);
  }
  const bucket = await response.json();
  if (bucket.id !== "documents" || bucket.public !== false) {
    throw new Error("The staging documents bucket is missing or is not private.");
  }
  console.log("The staging documents bucket exists and is private.");
} else if (mode === "embedding") {
  requireSettings(["STAGING_OPENAI_API_KEY"]);
  if (!process.env.STAGING_OPENAI_API_KEY.startsWith("sk-")) {
    throw new Error("STAGING_OPENAI_API_KEY is not shaped like an OpenAI API key.");
  }
  console.log("The staging embedding provider configuration is present.");
} else if (mode === "runtime") {
  requireSettings([
    "STAGING_SUPABASE_PROJECT_REF",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DATABASE_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ]);

  // These come from Vercel's own pulled Preview environment config (via
  // `vercel pull`), not from the GitHub Actions secrets the rest of this
  // workflow (migrations, the E2E fixture script, RLS checks) operates
  // against -- nothing before this point cross-checks that Vercel's config
  // actually still points at the same staging Supabase project. A drifted
  // or stale value here would deploy an app that authenticates against a
  // different Supabase project than the one the fixture just seeded,
  // producing a login failure with no other visible symptom.
  const projectRef = process.env.STAGING_SUPABASE_PROJECT_REF;
  requireProjectRef(projectRef);
  const supabaseUrl = parseUrl("NEXT_PUBLIC_SUPABASE_URL");
  if (supabaseUrl.hostname !== `${projectRef}.supabase.co`) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL (from Vercel's pulled Preview environment) does not match " +
        "STAGING_SUPABASE_PROJECT_REF -- the deployed app would authenticate against a " +
        "different Supabase project than the one migrations and the E2E fixture just ran against.",
    );
  }
  const databaseUrl = parseUrl("DATABASE_URL");
  const identifiesProject =
    databaseUrl.hostname.includes(projectRef) || databaseUrl.username.includes(projectRef);
  if (!identifiesProject) {
    throw new Error(
      "DATABASE_URL (from Vercel's pulled Preview environment) does not identify the " +
        "staging Supabase project ref -- the deployed app would read from a different " +
        "database than the one migrations and the E2E fixture just ran against.",
    );
  }

  console.log(
    "Required staging runtime setting names are present, and the deployed Supabase project matches staging.",
  );
} else if (mode === "e2e") {
  requireSettings(["E2E_USER_EMAIL", "E2E_USER_PASSWORD"]);
  console.log("Required authenticated staging E2E setting names are present.");
} else {
  throw new Error("STAGING_CONFIG_MODE must be identity, storage, embedding, runtime, or e2e.");
}
