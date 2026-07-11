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
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),

  SENTRY_DSN: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
});

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
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
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
