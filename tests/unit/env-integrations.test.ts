import { afterEach, describe, expect, it, vi } from "vitest";
import { getAnthropicEnv, getOpenAIEnv, getResendEnv, getStripeEnv, getVapiEnv } from "@/env";

const ENV_KEYS = [
  "SKIP_ENV_VALIDATION",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER_MONTHLY",
  "STRIPE_PRICE_STARTER_ANNUAL",
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_ANNUAL",
  "VAPI_API_KEY",
  "VAPI_WEBHOOK_SECRET",
  "VAPI_WEBHOOK_CREDENTIAL_ID",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_RETRY_MAX_ATTEMPTS",
  "AI_RETRY_BASE_DELAY_MS",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "QSTASH_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SENTRY_DSN",
] as const;

const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setStripeEnv() {
  process.env.STRIPE_SECRET_KEY = "sk_test_provider_isolation";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_provider_isolation";
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter_monthly";
  process.env.STRIPE_PRICE_STARTER_ANNUAL = "price_starter_annual";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly";
  process.env.STRIPE_PRICE_PRO_ANNUAL = "price_pro_annual";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
}

function setVapiEnv() {
  process.env.VAPI_API_KEY = "vapi-provider-isolation";
  process.env.VAPI_WEBHOOK_SECRET = "vapi-webhook-secret-at-least-16";
  process.env.VAPI_WEBHOOK_CREDENTIAL_ID = "cred_vapi_provider_isolation";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
}

function setOpenAIEnv() {
  process.env.OPENAI_API_KEY = "openai-provider-isolation";
  delete process.env.AI_RETRY_MAX_ATTEMPTS;
  delete process.env.AI_RETRY_BASE_DELAY_MS;
}

function setAnthropicEnv() {
  process.env.ANTHROPIC_API_KEY = "anthropic-provider-isolation";
  delete process.env.AI_RETRY_MAX_ATTEMPTS;
  delete process.env.AI_RETRY_BASE_DELAY_MS;
}

function setResendEnv() {
  process.env.RESEND_API_KEY = "resend-provider-isolation";
  process.env.EMAIL_FROM = "Syveka <noreply@example.test>";
}

function expectRedactedFailure(run: () => unknown, field: string, secret: string) {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(field);
  expect((thrown as Error).message).not.toContain(secret);
  expect(JSON.stringify(errorSpy.mock.calls)).toContain(field);
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

describe("provider-isolated environment getters", () => {
  it("validates Stripe without reading unrelated provider, infrastructure, or public Stripe fields", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setStripeEnv();
    process.env.VAPI_WEBHOOK_SECRET = "short";
    delete process.env.QSTASH_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "not-a-url";
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "not-a-publishable-key";

    expect(getStripeEnv()).toMatchObject({
      STRIPE_SECRET_KEY: "sk_test_provider_isolation",
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    });
  });

  it("fails clearly and redacts an invalid Stripe value", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setStripeEnv();
    const secret = "stripe-secret-must-not-leak";
    process.env.STRIPE_SECRET_KEY = secret;

    expectRedactedFailure(getStripeEnv, "STRIPE_SECRET_KEY", secret);
  });

  it("fails clearly when a required Stripe field is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setStripeEnv();
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => getStripeEnv()).toThrow(/STRIPE_PRICE_PRO_ANNUAL/);
  });

  it("validates Vapi without reading unrelated provider or infrastructure fields", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setVapiEnv();
    process.env.STRIPE_SECRET_KEY = "invalid";
    delete process.env.OPENAI_API_KEY;
    process.env.SENTRY_DSN = "not-a-url";

    expect(getVapiEnv()).toEqual({
      VAPI_API_KEY: "vapi-provider-isolation",
      VAPI_WEBHOOK_SECRET: "vapi-webhook-secret-at-least-16",
      VAPI_WEBHOOK_CREDENTIAL_ID: "cred_vapi_provider_isolation",
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    });
  });

  it("fails clearly and redacts an invalid Vapi value", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setVapiEnv();
    const secret = "short-secret";
    process.env.VAPI_WEBHOOK_SECRET = secret;

    expectRedactedFailure(getVapiEnv, "VAPI_WEBHOOK_SECRET", secret);
  });

  it("fails clearly when a required Vapi field is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setVapiEnv();
    delete process.env.VAPI_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => getVapiEnv()).toThrow(/VAPI_API_KEY/);
  });

  it("validates OpenAI independently and preserves retry defaults", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setOpenAIEnv();
    delete process.env.ANTHROPIC_API_KEY;
    process.env.STRIPE_SECRET_KEY = "invalid";
    process.env.SENTRY_DSN = "not-a-url";

    expect(getOpenAIEnv()).toEqual({
      OPENAI_API_KEY: "openai-provider-isolation",
      AI_RETRY_MAX_ATTEMPTS: 3,
      AI_RETRY_BASE_DELAY_MS: 250,
    });
  });

  it("preserves OpenAI retry coercion and bounds", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setOpenAIEnv();
    process.env.AI_RETRY_MAX_ATTEMPTS = "6";
    process.env.AI_RETRY_BASE_DELAY_MS = "10000";

    expect(getOpenAIEnv()).toMatchObject({
      AI_RETRY_MAX_ATTEMPTS: 6,
      AI_RETRY_BASE_DELAY_MS: 10_000,
    });

    process.env.AI_RETRY_MAX_ATTEMPTS = "7";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => getOpenAIEnv()).toThrow(/AI_RETRY_MAX_ATTEMPTS/);
  });

  it("fails clearly and redacts an invalid OpenAI retry value", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setOpenAIEnv();
    const secret = "retry-secret-must-not-leak";
    process.env.AI_RETRY_MAX_ATTEMPTS = secret;

    expectRedactedFailure(getOpenAIEnv, "AI_RETRY_MAX_ATTEMPTS", secret);
  });

  it("fails clearly when the OpenAI API key is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setOpenAIEnv();
    delete process.env.OPENAI_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => getOpenAIEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("validates Anthropic independently and preserves retry defaults", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setAnthropicEnv();
    delete process.env.OPENAI_API_KEY;
    delete process.env.RESEND_API_KEY;
    process.env.UPSTASH_REDIS_REST_URL = "not-a-url";

    expect(getAnthropicEnv()).toEqual({
      ANTHROPIC_API_KEY: "anthropic-provider-isolation",
      AI_RETRY_MAX_ATTEMPTS: 3,
      AI_RETRY_BASE_DELAY_MS: 250,
    });
  });

  it("fails clearly and redacts an invalid Anthropic retry value", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setAnthropicEnv();
    const secret = "retry-secret-must-not-leak";
    process.env.AI_RETRY_BASE_DELAY_MS = secret;

    expectRedactedFailure(getAnthropicEnv, "AI_RETRY_BASE_DELAY_MS", secret);
  });

  it("fails clearly when a required Anthropic field is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setAnthropicEnv();
    delete process.env.ANTHROPIC_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => getAnthropicEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("validates Resend without reading unrelated provider or infrastructure fields", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setResendEnv();
    delete process.env.QSTASH_TOKEN;
    process.env.STRIPE_WEBHOOK_SECRET = "invalid";
    process.env.SENTRY_DSN = "not-a-url";

    expect(getResendEnv()).toEqual({
      RESEND_API_KEY: "resend-provider-isolation",
      EMAIL_FROM: "Syveka <noreply@example.test>",
    });
  });

  it("fails clearly and redacts an invalid Resend value", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setResendEnv();
    const secret = "resend-secret-must-not-leak";
    process.env.EMAIL_FROM = "";
    process.env.RESEND_API_KEY = secret;

    expectRedactedFailure(getResendEnv, "EMAIL_FROM", secret);
  });

  it("fails clearly when a required Resend field is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    setResendEnv();
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => getResendEnv()).toThrow(/RESEND_API_KEY/);
  });

  it("preserves raw provider values when environment validation is skipped", () => {
    process.env.SKIP_ENV_VALIDATION = "1";
    process.env.STRIPE_SECRET_KEY = "not-a-stripe-key";
    process.env.NEXT_PUBLIC_APP_URL = "not-a-url";
    process.env.OPENAI_API_KEY = "";
    process.env.AI_RETRY_MAX_ATTEMPTS = "not-a-number";

    expect(getStripeEnv().STRIPE_SECRET_KEY).toBe("not-a-stripe-key");
    expect(getStripeEnv().NEXT_PUBLIC_APP_URL).toBe("not-a-url");
    expect(getOpenAIEnv().OPENAI_API_KEY).toBe("");
    expect(getOpenAIEnv().AI_RETRY_MAX_ATTEMPTS).toBe("not-a-number");
  });
});
