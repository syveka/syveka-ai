const mode = process.env.STAGING_CONFIG_MODE;

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
function parseUrl(name) {
  try {
    return new URL(process.env[name]);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
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
