import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ success: true })),
  signInWithPassword: vi.fn(async () => ({ error: null })),
  signUp: vi.fn(async () => ({ error: null })),
  resetPasswordForEmail: vi.fn(async () => ({ error: null })),
  updateUser: vi.fn(async () => ({ error: null })),
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
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signUp: mocks.signUp,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      updateUser: mocks.updateUser,
    },
  }),
}));

import {
  loginAction,
  registerAction,
  forgotPasswordAction,
  resetPasswordAction,
} from "@/actions/auth";

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

  it("sends a recovery link that lands on reset-password, not the app default", async () => {
    const form = new FormData();
    form.set("email", "user@example.com");
    form.set("locale", "fi");

    await expect(forgotPasswordAction({}, form)).resolves.toEqual({
      message: "verify_email_sent",
    });
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "user@example.com",
      expect.objectContaining({
        redirectTo: "https://staging.example.test/api/auth/callback?next=%2Ffi%2Freset-password",
      }),
    );
  });

  it("always reports success from forgot-password, even for an unknown address", async () => {
    // §13: never leak account existence through a different response shape.
    mocks.resetPasswordForEmail.mockResolvedValueOnce({
      error: { message: "not found" } as never,
    });
    const form = new FormData();
    form.set("email", "unknown@example.com");
    form.set("locale", "en");

    await expect(forgotPasswordAction({}, form)).resolves.toEqual({
      message: "verify_email_sent",
    });
  });

  it("updates the password on an active (recovery) session and redirects to dashboard", async () => {
    const form = new FormData();
    form.set("password", "a-new-secure-password");
    form.set("locale", "en");

    await expect(resetPasswordAction({}, form)).rejects.toThrow("NEXT_REDIRECT:/en/dashboard");
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "a-new-secure-password" });
  });

  it("rejects a reset password shorter than the registration floor without calling Supabase", async () => {
    const form = new FormData();
    form.set("password", "short");
    form.set("locale", "en");

    await expect(resetPasswordAction({}, form)).resolves.toEqual({ error: "invalid_input" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("reports reset_failed when there is no session to update (expired/reused link)", async () => {
    mocks.updateUser.mockResolvedValueOnce({
      error: { message: "Auth session missing" } as never,
    });
    const form = new FormData();
    form.set("password", "a-new-secure-password");
    form.set("locale", "en");

    await expect(resetPasswordAction({}, form)).resolves.toEqual({ error: "reset_failed" });
  });
});
