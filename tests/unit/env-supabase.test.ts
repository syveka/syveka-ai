import { afterEach, describe, expect, it } from "vitest";
import { getSupabaseServerEnv } from "@/env";

const SNAPSHOT_KEYS = [
  "SKIP_ENV_VALIDATION",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SNAPSHOT_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

describe("getSupabaseServerEnv", () => {
  it("resolves Supabase credentials without requiring unrelated required server vars", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    // tests/setup/env.ts only seeds NEXT_PUBLIC_*/OPENAI_API_KEY, so
    // STRIPE_SECRET_KEY, QSTASH_TOKEN, VAPI_API_KEY, etc. are unset here --
    // getSupabaseServerEnv must succeed regardless, unlike the full server
    // schema (and unlike the full client schema's NEXT_PUBLIC_APP_URL /
    // NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, which it also must not require).
    expect(getSupabaseServerEnv()).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    });
  });

  it("succeeds even when NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY are missing or malformed", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    expect(() => getSupabaseServerEnv()).not.toThrow();
  });

  it("throws a field-name-only error when a Supabase var itself is missing or malformed", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-valid-url";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    expect(() => getSupabaseServerEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
