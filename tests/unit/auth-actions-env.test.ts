import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ success: true })),
  signInWithPassword: vi.fn(async () => ({ error: null })),
  signUp: vi.fn(async () => ({ error: null })),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@upstash/redis", () => ({ Redis: class Redis {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow() {
      return {};
    }
    limit = mocks.rateLimit;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: { signInWithPassword: mocks.signInWithPassword, signUp: mocks.signUp },
  }),
}));

import { loginAction } from "@/actions/auth";
import { registerAction } from "@/actions/auth";

const ENV_NAMES = [
  "SKIP_ENV_VALIDATION",
  "NEXT_PUBLIC_APP_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "DIRECT_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "VAPI_API_KEY",
  "VAPI_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
] as const;
const snapshot = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

describe("login environment isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    process.env.NEXT_PUBLIC_APP_URL = "https://staging.example.test";
    for (const name of [
      "DIRECT_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ANTHROPIC_API_KEY",
      "VAPI_API_KEY",
      "VAPI_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
    ]) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (snapshot[name] === undefined) delete process.env[name];
      else process.env[name] = snapshot[name];
    }
  });

  it("reaches Supabase without unrelated feature credentials", async () => {
    const form = new FormData();
    form.set("email", "user@example.com");
    form.set("password", "password");
    form.set("locale", "en");

    await expect(loginAction({}, form)).rejects.toThrow("NEXT_REDIRECT:/en/dashboard");
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "password",
    });
  });

  it("sends registration through the locale-preserving PKCE callback", async () => {
    const form = new FormData();
    form.set("fullName", "Test User");
    form.set("email", "user@example.com");
    form.set("password", "a-secure-password");
    form.set("locale", "ar");

    await expect(registerAction({}, form)).resolves.toEqual({ message: "verify_email_sent" });
    expect(mocks.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          emailRedirectTo: "https://staging.example.test/api/auth/callback?next=%2Far%2Fonboarding",
        }),
      }),
    );
  });
});
