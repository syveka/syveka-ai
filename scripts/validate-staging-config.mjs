const required = [
  "STAGING_SUPABASE_PROJECT_REF",
  "STAGING_SUPABASE_URL",
  "STAGING_DATABASE_URL",
  "STAGING_DIRECT_URL",
  "STAGING_SUPABASE_SERVICE_ROLE_KEY",
  "STAGING_OPENAI_API_KEY",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required staging-only setting: ${name}`);
  }
}

const projectRef = process.env.STAGING_SUPABASE_PROJECT_REF;
if (!/^[a-z0-9]{20}$/.test(projectRef)) {
  throw new Error("STAGING_SUPABASE_PROJECT_REF must be a 20-character Supabase project ref.");
}

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

if (!process.env.STAGING_OPENAI_API_KEY.startsWith("sk-")) {
  throw new Error("STAGING_OPENAI_API_KEY is not shaped like an OpenAI API key.");
}

if (process.env.SKIP_STORAGE_CHECK !== "1") {
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
}

console.log("Staging project identity and embedding configuration are valid.");
if (process.env.SKIP_STORAGE_CHECK !== "1") {
  console.log("The staging documents bucket exists and is private.");
}
