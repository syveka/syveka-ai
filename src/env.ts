import { z } from "zod";

/**
 * Zod-validated environment.
 * Import `env` everywhere instead of touching process.env directly.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),

  VAPI_API_KEY: z.string().min(1),
  VAPI_WEBHOOK_SECRET: z.string().min(16),
  // ID of a Vapi Custom Credential (HMAC) — not itself a secret, just a
  // reference; the credential's key material lives only in Vapi and in
  // VAPI_WEBHOOK_SECRET above, never in this value.
  VAPI_WEBHOOK_CREDENTIAL_ID: z.string().min(1),

  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_PRICE_STARTER_MONTHLY: z.string().startsWith("price_"),
  STRIPE_PRICE_STARTER_ANNUAL: z.string().startsWith("price_"),
  STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith("price_"),
  STRIPE_PRICE_PRO_ANNUAL: z.string().startsWith("price_"),

  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(3),

  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  AI_CHAT_USER_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  AI_CHAT_ORG_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  AI_CHAT_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
  AI_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  AI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(10_000).default(250),
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),

  SENTRY_DSN: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),

  // Calendar integrations (all optional — the feature degrades gracefully:
  // providers without credentials are hidden; MOCK covers dev/test).
  CALENDAR_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  CALENDAR_OAUTH_STATE_SECRET: z.string().min(16).optional(),
  CALENDAR_MOCK_PROVIDER: z.enum(["0", "1"]).optional(),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CALENDAR_CLIENT_ID: z.string().optional(),
  MICROSOFT_CALENDAR_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CALENDAR_TENANT: z.string().optional(),

  // Inbox email channel (optional — MOCK covers dev/test/credential-less
  // environments; the webhook secret gates the inbound-email endpoint).
  INBOX_EMAIL_MOCK_PROVIDER: z.enum(["0", "1"]).optional(),
  INBOX_EMAIL_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Domain organization mailbox addresses are provisioned under
  // ({slug}@this-domain) — requires real DNS/MX configuration to receive
  // mail; see docs/inbox-architecture.md.
  INBOX_EMAIL_DOMAIN: z.string().optional(),
  // Resend's inbound-email webhook signing secret (svix), from the Resend
  // dashboard's Webhooks page for the endpoint below — distinct from
  // INBOX_EMAIL_WEBHOOK_SECRET, which gates the provider-agnostic endpoint.
  RESEND_INBOUND_WEBHOOK_SECRET: z.string().optional(),
});

function providerEnvError(label: string, invalidFields: string[]): Error {
  console.error(`Invalid ${label} environment variables:`, invalidFields);
  return new Error(`Invalid ${label} environment variables: ${invalidFields.join(", ")}`);
}

const stripeEnvSchema = serverSchema
  .pick({
    STRIPE_SECRET_KEY: true,
    STRIPE_WEBHOOK_SECRET: true,
    STRIPE_PRICE_STARTER_MONTHLY: true,
    STRIPE_PRICE_STARTER_ANNUAL: true,
    STRIPE_PRICE_PRO_MONTHLY: true,
    STRIPE_PRICE_PRO_ANNUAL: true,
  })
  .extend({ NEXT_PUBLIC_APP_URL: z.string().url() });

export function getStripeEnv(): z.infer<typeof stripeEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY as string,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET as string,
      STRIPE_PRICE_STARTER_MONTHLY: process.env.STRIPE_PRICE_STARTER_MONTHLY as string,
      STRIPE_PRICE_STARTER_ANNUAL: process.env.STRIPE_PRICE_STARTER_ANNUAL as string,
      STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY as string,
      STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL as string,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL as string,
    };
  }

  const parsed = stripeEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw providerEnvError("Stripe", Object.keys(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}

const vapiEnvSchema = serverSchema
  .pick({ VAPI_API_KEY: true, VAPI_WEBHOOK_SECRET: true, VAPI_WEBHOOK_CREDENTIAL_ID: true })
  .extend({ NEXT_PUBLIC_APP_URL: z.string().url() });

export function getVapiEnv(): z.infer<typeof vapiEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      VAPI_API_KEY: process.env.VAPI_API_KEY as string,
      VAPI_WEBHOOK_SECRET: process.env.VAPI_WEBHOOK_SECRET as string,
      VAPI_WEBHOOK_CREDENTIAL_ID: process.env.VAPI_WEBHOOK_CREDENTIAL_ID as string,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL as string,
    };
  }

  const parsed = vapiEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw providerEnvError("Vapi", Object.keys(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}

const openAIEnvSchema = serverSchema.pick({
  OPENAI_API_KEY: true,
  AI_RETRY_MAX_ATTEMPTS: true,
  AI_RETRY_BASE_DELAY_MS: true,
});

export function getOpenAIEnv(): z.infer<typeof openAIEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY as string,
      AI_RETRY_MAX_ATTEMPTS: process.env.AI_RETRY_MAX_ATTEMPTS as unknown as number,
      AI_RETRY_BASE_DELAY_MS: process.env.AI_RETRY_BASE_DELAY_MS as unknown as number,
    };
  }

  const parsed = openAIEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw providerEnvError("OpenAI", Object.keys(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}

const anthropicEnvSchema = serverSchema.pick({
  ANTHROPIC_API_KEY: true,
  AI_RETRY_MAX_ATTEMPTS: true,
  AI_RETRY_BASE_DELAY_MS: true,
});

export function getAnthropicEnv(): z.infer<typeof anthropicEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY as string,
      AI_RETRY_MAX_ATTEMPTS: process.env.AI_RETRY_MAX_ATTEMPTS as unknown as number,
      AI_RETRY_BASE_DELAY_MS: process.env.AI_RETRY_BASE_DELAY_MS as unknown as number,
    };
  }

  const parsed = anthropicEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw providerEnvError("Anthropic", Object.keys(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}

const resendEnvSchema = serverSchema.pick({ RESEND_API_KEY: true, EMAIL_FROM: true });

export function getResendEnv(): z.infer<typeof resendEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      RESEND_API_KEY: process.env.RESEND_API_KEY as string,
      EMAIL_FROM: process.env.EMAIL_FROM as string,
    };
  }

  const parsed = resendEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw providerEnvError("Resend", Object.keys(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}

/**
 * Redis-only subset of `serverSchema`, validated independently.
 *
 * `getRedisEnv()` must not go through `getServerEnv()`: that validates the
 * entire ~25-key server schema (Stripe, Vapi, QStash, Resend, ...) and
 * throws if *any* field is missing, even ones Redis never touches. That
 * coupling previously made `/api/health`'s "redis" check fail for reasons
 * that had nothing to do with Redis.
 */
const redisEnvSchema = serverSchema.pick({
  UPSTASH_REDIS_REST_URL: true,
  UPSTASH_REDIS_REST_TOKEN: true,
  AI_CHAT_USER_RATE_LIMIT: true,
  AI_CHAT_ORG_RATE_LIMIT: true,
  AI_CHAT_RATE_WINDOW_SECONDS: true,
});

export function getRedisEnv(): z.infer<typeof redisEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? "",
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
      AI_CHAT_USER_RATE_LIMIT: process.env.AI_CHAT_USER_RATE_LIMIT as unknown as number,
      AI_CHAT_ORG_RATE_LIMIT: process.env.AI_CHAT_ORG_RATE_LIMIT as unknown as number,
      AI_CHAT_RATE_WINDOW_SECONDS: process.env.AI_CHAT_RATE_WINDOW_SECONDS as unknown as number,
    };
  }

  const parsed = redisEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid Redis environment variables:", invalidFields);
    throw new Error(`Invalid Redis environment variables: ${invalidFields.join(", ")}`);
  }
  return parsed.data;
}

/**
 * Supabase-only subset, validated independently of the full client+server
 * merge.
 *
 * `createSupabaseServer()`/`createSupabaseAdmin()` only need these three
 * fields, but reading them through `env` (the merged Proxy) forces the
 * *entire* client schema to validate first -- including
 * NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, which have
 * nothing to do with Supabase. That coupling turned an unrelated
 * misconfigured Stripe/app-url value into a 500 on every authenticated
 * request (surfaced by the ai/files/upload-url smoke test, which -- unlike
 * ai/chat's blanket catch -- doesn't swallow non-auth errors). Same root
 * cause and same fix shape as `getRedisEnv()` above.
 */
const supabaseAuthEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const supabaseAdminEnvSchema = supabaseAuthEnvSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export function getSupabaseAuthEnv(): z.infer<typeof supabaseAuthEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    };
  }

  const parsed = supabaseAuthEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid Supabase auth environment variables:", invalidFields);
    throw new Error(`Invalid Supabase auth environment variables: ${invalidFields.join(", ")}`);
  }
  return parsed.data;
}

export function getSupabaseAdminEnv(): z.infer<typeof supabaseAdminEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      ...getSupabaseAuthEnv(),
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    };
  }

  const parsed = supabaseAdminEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid Supabase admin environment variables:", invalidFields);
    throw new Error(`Invalid Supabase admin environment variables: ${invalidFields.join(", ")}`);
  }
  return parsed.data;
}

const appUrlEnvSchema = z.object({ NEXT_PUBLIC_APP_URL: z.string().url() });

export function getAppUrlEnv(): z.infer<typeof appUrlEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return { NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "" };
  }

  const parsed = appUrlEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid application URL environment variable:", invalidFields);
    throw new Error(`Invalid application URL environment variable: ${invalidFields.join(", ")}`);
  }
  return parsed.data;
}

/**
 * QStash-only subset, validated independently of the full client+server
 * merge.
 *
 * `verifyJobRequest()` (signature verification, used by every job route) and
 * `enqueue()` (job publishing) only need these four fields, but reading them
 * through `env` forces the entire ~25-field server schema plus the 4-field
 * client schema to validate first -- including fields QStash has nothing to
 * do with (Stripe, Vapi, Resend, calendar, ...). `verifyJobRequest()` calls
 * its receiver constructor outside its own try/catch, so an unrelated
 * misconfigured field anywhere in that schema would throw unhandled and 500
 * every one of the six QStash job routes (post-call, run-workflow,
 * usage-rollup, send-reminder, embed-document, calendar-sync) at once. Same
 * root cause and same fix shape as `getRedisEnv()`/`getSupabaseAuthEnv()`
 * above.
 */
const qstashEnvSchema = z.object({
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export function getQstashEnv(): z.infer<typeof qstashEnvSchema> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      QSTASH_TOKEN: process.env.QSTASH_TOKEN ?? "",
      QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY ?? "",
      QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY ?? "",
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "",
    };
  }

  const parsed = qstashEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid QStash environment variables:", invalidFields);
    throw new Error(`Invalid QStash environment variables: ${invalidFields.join(", ")}`);
  }
  return parsed.data;
}

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
});

type ClientEnv = z.infer<typeof clientSchema>;
type ServerEnv = z.infer<typeof serverSchema> & ClientEnv;

let cachedClientEnv: ClientEnv | null = null;
let cachedServerEnv: ServerEnv | null = null;

function getClientEnv(): ClientEnv {
  if (
    process.env.SKIP_ENV_VALIDATION === "1" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) {
    cachedClientEnv ??= process.env as unknown as ClientEnv;
    return cachedClientEnv;
  }

  cachedClientEnv ??= clientSchema.parse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  });
  return cachedClientEnv;
}

function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("env (server) imported in the browser; use clientEnv.");
  }

  // CI builds compile without real secrets; runtime always validates.
  if (
    process.env.SKIP_ENV_VALIDATION === "1" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) {
    cachedServerEnv ??= {
      ...(process.env as unknown as z.infer<typeof serverSchema>),
      ...getClientEnv(),
    };
    return cachedServerEnv;
  }

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const invalidFields = Object.keys(parsed.error.flatten().fieldErrors);
    console.error("Invalid environment variables:", invalidFields);
    throw new Error(`Invalid environment variables: ${invalidFields.join(", ")}`);
  }

  cachedServerEnv ??= { ...parsed.data, ...getClientEnv() };
  return cachedServerEnv;
}

/** Client-safe env: the only values that may reach the browser. */
export const clientEnv = new Proxy({} as ClientEnv, {
  get(_target, prop: keyof ClientEnv) {
    return getClientEnv()[prop];
  },
});

/** Server env. Never import from a client component. */
export const env = new Proxy({} as ServerEnv, {
  get(_target, prop: keyof ServerEnv) {
    return getServerEnv()[prop];
  },
});
