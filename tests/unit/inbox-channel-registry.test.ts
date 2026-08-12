import { beforeEach, describe, expect, it, vi } from "vitest";

const { emailAdapterMock } = vi.hoisted(() => ({
  emailAdapterMock: { send: vi.fn(async () => ({ externalId: "ext-1" })) },
}));

vi.mock("@/server/channels/email", () => ({
  getEmailChannelAdapter: () => emailAdapterMock,
}));

import { getChannelAdapter } from "@/server/channels/registry";

describe("getChannelAdapter", () => {
  beforeEach(() => {
    emailAdapterMock.send.mockClear();
  });

  it("returns an adapter for EMAIL that delegates to the email channel adapter", async () => {
    const adapter = getChannelAdapter("EMAIL");
    expect(adapter).not.toBeNull();

    await adapter!.send({
      to: "customer@example.com",
      body: "Thanks!",
      subject: "Re: Order #42",
      replyToExternalId: "prev-ext-1",
    });

    expect(emailAdapterMock.send).toHaveBeenCalledWith({
      to: "customer@example.com",
      subject: "Re: Order #42",
      text: "Thanks!",
      inReplyToExternalId: "prev-ext-1",
    });
  });

  it("falls back to a generic subject when none is given", async () => {
    const adapter = getChannelAdapter("EMAIL");
    await adapter!.send({ to: "customer@example.com", body: "Hi" });

    expect(emailAdapterMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: your message" }),
    );
  });

  it.each(["SMS", "WHATSAPP", "WEB_CHAT"] as const)(
    "returns null for %s, which has no adapter yet",
    (channel) => {
      expect(getChannelAdapter(channel)).toBeNull();
    },
  );
});
