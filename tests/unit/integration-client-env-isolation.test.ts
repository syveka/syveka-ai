import { createHmac } from "node:crypto";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stripeConstructor: vi.fn(),
  openAIConstructor: vi.fn(),
  anthropicConstructor: vi.fn(),
  resendConstructor: vi.fn(),
  resendSend: vi.fn(async () => ({ data: { id: "email-1" }, error: null })),
  fetch: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    customers = {};
    checkout = { sessions: {} };
    billingPortal = { sessions: {} };
    webhooks = {};

    constructor(secret: string, options: unknown) {
      mocks.stripeConstructor(secret, options);
    }
  },
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    embeddings = {};
    moderations = {};

    constructor(options: unknown) {
      mocks.openAIConstructor(options);
    }
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = {};

    constructor(options: unknown) {
      mocks.anthropicConstructor(options);
    }
  },
}));

vi.mock("resend", () => ({
  Resend: class ResendMock {
    emails = { send: mocks.resendSend };

    constructor(apiKey: string) {
      mocks.resendConstructor(apiKey);
    }
  },
}));

const ENV_KEYS = [
  "SKIP_ENV_VALIDATION",
  "NEXT_PUBLIC_APP_URL",
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
  "SENTRY_DSN",
] as const;

const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setProviderEnvs() {
  delete process.env.SKIP_ENV_VALIDATION;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  process.env.STRIPE_SECRET_KEY = "sk_test_provider_isolation";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_provider_isolation";
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter_monthly";
  process.env.STRIPE_PRICE_STARTER_ANNUAL = "price_starter_annual";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly";
  process.env.STRIPE_PRICE_PRO_ANNUAL = "price_pro_annual";
  process.env.VAPI_API_KEY = "vapi-provider-isolation";
  process.env.VAPI_WEBHOOK_SECRET = "vapi-webhook-secret-at-least-16";
  process.env.VAPI_WEBHOOK_CREDENTIAL_ID = "cred_vapi_provider_isolation";
  process.env.OPENAI_API_KEY = "openai-provider-isolation";
  process.env.ANTHROPIC_API_KEY = "anthropic-provider-isolation";
  delete process.env.AI_RETRY_MAX_ATTEMPTS;
  delete process.env.AI_RETRY_BASE_DELAY_MS;
  process.env.RESEND_API_KEY = "resend-provider-isolation";
  process.env.EMAIL_FROM = "Syveka <noreply@example.test>";
  // The monolithic server schema rejects this. Provider-isolated clients must ignore it.
  process.env.SENTRY_DSN = "not-a-url";
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  setProviderEnvs();
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => "",
  } as Response);
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

describe("provider client environment isolation", () => {
  it("keeps Stripe, OpenAI, Anthropic, and Resend clients lazy and cached", async () => {
    const stripeModule = await import("@/server/integrations/stripe");
    const openAIModule = await import("@/server/integrations/openai");
    const anthropicModule = await import("@/server/integrations/anthropic");
    const resendModule = await import("@/server/integrations/resend");

    expect(mocks.stripeConstructor).not.toHaveBeenCalled();
    expect(mocks.openAIConstructor).not.toHaveBeenCalled();
    expect(mocks.anthropicConstructor).not.toHaveBeenCalled();
    expect(mocks.resendConstructor).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();

    void stripeModule.stripe.customers;
    void openAIModule.openai.embeddings;
    void anthropicModule.anthropic.messages;
    await resendModule.sendEmail({
      to: "recipient@example.test",
      subject: "Provider isolation",
      react: {} as ReactElement,
    });

    expect(mocks.stripeConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.openAIConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.anthropicConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.resendConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();

    void stripeModule.stripe.customers;
    void openAIModule.openai.embeddings;
    void anthropicModule.anthropic.messages;
    await resendModule.sendEmail({
      to: "recipient@example.test",
      subject: "Provider isolation again",
      react: {} as ReactElement,
    });

    expect(mocks.stripeConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.openAIConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.anthropicConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.resendConstructor).toHaveBeenCalledTimes(1);
  });

  it("keeps Vapi import and signature verification network-free", async () => {
    const vapiModule = await import("@/server/integrations/vapi");
    expect(mocks.fetch).not.toHaveBeenCalled();

    const body = JSON.stringify({ type: "status-update" });
    const signature = createHmac("sha256", process.env.VAPI_WEBHOOK_SECRET!)
      .update(body)
      .digest("hex");
    expect(vapiModule.verifyVapiSignature(body, signature)).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();

    await vapiModule.deleteVapiAssistant("assistant-1");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails before provider construction or requests when provider keys are missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    delete process.env.STRIPE_SECRET_KEY;
    const stripeModule = await import("@/server/integrations/stripe");
    expect(() => stripeModule.stripe.customers).toThrow(/STRIPE_SECRET_KEY/);
    expect(mocks.stripeConstructor).not.toHaveBeenCalled();

    process.env.STRIPE_SECRET_KEY = "sk_test_provider_isolation";
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const openAIModule = await import("@/server/integrations/openai");
    expect(() => openAIModule.openai.embeddings).toThrow(/OPENAI_API_KEY/);
    expect(mocks.openAIConstructor).not.toHaveBeenCalled();

    process.env.OPENAI_API_KEY = "openai-provider-isolation";
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const anthropicModule = await import("@/server/integrations/anthropic");
    expect(() => anthropicModule.anthropic.messages).toThrow(/ANTHROPIC_API_KEY/);
    expect(mocks.anthropicConstructor).not.toHaveBeenCalled();

    process.env.ANTHROPIC_API_KEY = "anthropic-provider-isolation";
    delete process.env.RESEND_API_KEY;
    vi.resetModules();
    const resendModule = await import("@/server/integrations/resend");
    await expect(
      resendModule.sendEmail({
        to: "recipient@example.test",
        subject: "Provider isolation",
        react: {} as ReactElement,
      }),
    ).rejects.toThrow(/RESEND_API_KEY/);
    expect(mocks.resendConstructor).not.toHaveBeenCalled();

    process.env.RESEND_API_KEY = "resend-provider-isolation";
    delete process.env.VAPI_API_KEY;
    vi.resetModules();
    const vapiModule = await import("@/server/integrations/vapi");
    await expect(vapiModule.deleteVapiAssistant("assistant-1")).rejects.toThrow(/VAPI_API_KEY/);
    expect(mocks.fetch).not.toHaveBeenCalled();

    const output = JSON.stringify(errorSpy.mock.calls);
    expect(output).not.toContain("sk_test_provider_isolation");
    expect(output).not.toContain("openai-provider-isolation");
    expect(output).not.toContain("anthropic-provider-isolation");
    expect(output).not.toContain("resend-provider-isolation");
    expect(output).not.toContain("vapi-provider-isolation");
  });
});
