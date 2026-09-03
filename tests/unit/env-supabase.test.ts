import { afterEach, describe, expect, it } from "vitest";
import { getSupabaseAdminEnv, getSupabaseAuthEnv } from "@/env";

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

describe("scoped Supabase environment getters", () => {
  it("resolves auth credentials without requiring service-role or unrelated server vars", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    // tests/setup/env.ts only seeds NEXT_PUBLIC_*/OPENAI_API_KEY, so
    // STRIPE_SECRET_KEY, QSTASH_TOKEN, VAPI_API_KEY, etc. are unset here --
    // getSupabaseAuthEnv must succeed regardless, unlike the full server
    // schema (and unlike the full client schema's NEXT_PUBLIC_APP_URL /
    // NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, which it also must not require).
    expect(getSupabaseAuthEnv()).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    });
  });

  it("keeps the service-role key mandatory for admin operations", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => getSupabaseAdminEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("succeeds even when NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY are missing or malformed", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    expect(() => getSupabaseAuthEnv()).not.toThrow();
  });

  it("throws a field-name-only error when a Supabase var itself is missing or malformed", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-valid-url";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    expect(() => getSupabaseAuthEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  /**
   * DATABASE_URL was already proven, live on this exact staging environment
   * (see connection-string-sanitizer.ts), to occasionally carry a trailing
   * newline/whitespace that a lenient WHATWG URL parse (which Zod's `.url()`
   * is built on) tolerates silently. Nothing previously stopped the same
   * corruption from reaching NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/
   * SUPABASE_SERVICE_ROLE_KEY -- which wouldn't fail validation, but would
   * make every Supabase Auth API call carry a corrupted URL/apikey header.
   */
  it("trims trailing whitespace/newlines from Supabase URL, anon key, and service-role key", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co\n ";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = " test-anon-key\n";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "\ttest-service-role-key\r\n";

    expect(getSupabaseAuthEnv()).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    });
    expect(getSupabaseAdminEnv().SUPABASE_SERVICE_ROLE_KEY).toBe("test-service-role-key");
  });

  it("also trims when SKIP_ENV_VALIDATION bypasses full validation", () => {
    process.env.SKIP_ENV_VALIDATION = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co\n";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = " test-anon-key ";
    process.env.SUPABASE_SERVICE_ROLE_KEY = " test-service-role-key\n";

    expect(getSupabaseAuthEnv()).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    });
    expect(getSupabaseAdminEnv().SUPABASE_SERVICE_ROLE_KEY).toBe("test-service-role-key");
  });
});
