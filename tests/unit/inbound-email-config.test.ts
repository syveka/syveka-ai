import { afterEach, describe, expect, it, vi } from "vitest";
import { isInboundEmailConfigured } from "@/server/channels/email";

describe("isInboundEmailConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true only when both the mailbox domain and the Resend inbound secret are set", () => {
    vi.stubEnv("INBOX_EMAIL_DOMAIN", "inbox.example.test");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "whsec_test");
    expect(isInboundEmailConfigured()).toBe(true);
  });

  it.each([
    ["INBOX_EMAIL_DOMAIN", "RESEND_INBOUND_WEBHOOK_SECRET"],
    ["RESEND_INBOUND_WEBHOOK_SECRET", "INBOX_EMAIL_DOMAIN"],
  ])("is false when %s is missing", (missing, present) => {
    vi.stubEnv(present, "value");
    vi.stubEnv(missing, "");
    expect(isInboundEmailConfigured()).toBe(false);
  });
});
