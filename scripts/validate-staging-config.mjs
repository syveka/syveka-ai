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

  const supabaseUrl = new URL(process.env.STAGING_SUPABASE_URL);
  if (supabaseUrl.hostname !== `${projectRef}.supabase.co`) {
    throw new Error("STAGING_SUPABASE_URL does not match STAGING_SUPABASE_PROJECT_REF.");
  }

  for (const name of ["STAGING_DATABASE_URL", "STAGING_DIRECT_URL"]) {
    const databaseUrl = new URL(process.env[name]);
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
  const supabaseUrl = new URL(process.env.STAGING_SUPABASE_URL);
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
} else {
  throw new Error("STAGING_CONFIG_MODE must be identity, storage, or embedding.");
}
