import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockEmailChannelAdapter, mockEmailChannelTestApi } from "@/server/channels/email/mock";

describe("mock email channel adapter", () => {
  beforeEach(() => {
    mockEmailChannelTestApi.reset();
  });

  it("is always configured", () => {
    expect(mockEmailChannelAdapter.isConfigured()).toBe(true);
  });

  it("records every send with a unique external id", async () => {
    const first = await mockEmailChannelAdapter.send({
      to: "customer@example.com",
      subject: "Re: hello",
      text: "Thanks for reaching out!",
    });
    const second = await mockEmailChannelAdapter.send({
      to: "other@example.com",
      subject: "Re: hello",
      text: "Following up.",
    });

    expect(first.externalId).not.toBe(second.externalId);
    expect(mockEmailChannelTestApi.getSent()).toHaveLength(2);
    expect(mockEmailChannelTestApi.getSent()[0]).toMatchObject({
      to: "customer@example.com",
      externalId: first.externalId,
    });
  });
});

describe("getEmailChannelAdapter provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the mock adapter when INBOX_EMAIL_MOCK_PROVIDER=1", async () => {
    vi.stubEnv("INBOX_EMAIL_MOCK_PROVIDER", "1");
    const { getEmailChannelAdapter } = await import("@/server/channels/email");
    expect(getEmailChannelAdapter().provider).toBe("MOCK");
  });

  it("selects the mock adapter outside production when Resend is not configured", async () => {
    vi.stubEnv("INBOX_EMAIL_MOCK_PROVIDER", undefined);
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("EMAIL_FROM", undefined);
    vi.stubEnv("NODE_ENV", "test");
    const { getEmailChannelAdapter } = await import("@/server/channels/email");
    expect(getEmailChannelAdapter().provider).toBe("MOCK");
  });

  it("selects the Resend adapter when configured and not forced to mock", async () => {
    vi.stubEnv("INBOX_EMAIL_MOCK_PROVIDER", undefined);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "Syveka AI <no-reply@syveka.ai>");
    vi.stubEnv("NODE_ENV", "production");
    const { getEmailChannelAdapter } = await import("@/server/channels/email");
    expect(getEmailChannelAdapter().provider).toBe("RESEND");
  });
});
