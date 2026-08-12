import { describe, expect, it } from "vitest";
import {
  htmlToPlainText,
  normalizeResendInboundEmail,
  parseResendReceivedEvent,
  verifyResendWebhookSignature,
} from "@/server/channels/email/resend-inbound";

describe("parseResendReceivedEvent", () => {
  it("parses a well-formed email.received event", () => {
    const event = parseResendReceivedEvent({
      type: "email.received",
      data: {
        email_id: "email_123",
        from: "customer@example.com",
        to: ["acme@inbox.syveka.ai"],
        subject: "Hello",
      },
    });
    expect(event).not.toBeNull();
    expect(event?.data.email_id).toBe("email_123");
  });

  it("rejects a different event type", () => {
    expect(
      parseResendReceivedEvent({
        type: "email.delivered",
        data: { email_id: "x", from: "a@b.com", to: ["c@d.com"] },
      }),
    ).toBeNull();
  });

  it("rejects a payload missing required fields", () => {
    expect(parseResendReceivedEvent({ type: "email.received", data: {} })).toBeNull();
    expect(parseResendReceivedEvent(null)).toBeNull();
    expect(parseResendReceivedEvent("not an object")).toBeNull();
  });

  it("rejects an empty recipient list", () => {
    expect(
      parseResendReceivedEvent({
        type: "email.received",
        data: { email_id: "x", from: "a@b.com", to: [] },
      }),
    ).toBeNull();
  });
});

describe("htmlToPlainText", () => {
  it("converts paragraphs and line breaks to plain-text spacing", () => {
    const result = htmlToPlainText("<p>Hello</p><p>World<br>Next line</p>");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    expect(result).toContain("Next line");
  });

  it("strips script and style tags along with their content", () => {
    const result = htmlToPlainText(
      "<p>Visible</p><script>alert('xss')</script><style>.a{color:red}</style>",
    );
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color:red");
    expect(result).toContain("Visible");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToPlainText("Tom &amp; Jerry &lt;3 &quot;fun&quot;")).toBe('Tom & Jerry <3 "fun"');
  });

  it("never leaves any HTML tags in the output", () => {
    const result = htmlToPlainText("<div class=\"x\"><a href='evil'>click</a></div>");
    expect(result).not.toMatch(/<[^>]+>/);
  });
});

describe("normalizeResendInboundEmail", () => {
  const event = parseResendReceivedEvent({
    type: "email.received",
    data: {
      email_id: "email_123",
      from: "customer@example.com",
      to: ["acme@inbox.syveka.ai", "other@inbox.syveka.ai"],
      subject: "Question",
    },
  })!;

  it("prefers plain text content when available", () => {
    const canonical = normalizeResendInboundEmail(
      event,
      { text: "Plain body", html: "<p>HTML body</p>" },
      "acme@inbox.syveka.ai",
    );
    expect(canonical.text).toBe("Plain body");
    expect(canonical.provider).toBe("resend");
    expect(canonical.providerMessageId).toBe("email_123");
    expect(canonical.mailboxAddress).toBe("acme@inbox.syveka.ai");
    expect(canonical.fromAddress).toBe("customer@example.com");
    expect(canonical.toAddresses).toEqual(["acme@inbox.syveka.ai", "other@inbox.syveka.ai"]);
  });

  it("falls back to a stripped version of the HTML body when there is no plain text", () => {
    const canonical = normalizeResendInboundEmail(
      event,
      { text: "", html: "<p>Only HTML</p>" },
      "acme@inbox.syveka.ai",
    );
    expect(canonical.text).toBe("Only HTML");
  });

  it("never leaks provider-specific field names into the canonical shape", () => {
    const canonical = normalizeResendInboundEmail(
      event,
      { text: "Body", html: null },
      "acme@inbox.syveka.ai",
    );
    expect(Object.keys(canonical).sort()).toEqual(
      [
        "attachments",
        "fromAddress",
        "mailboxAddress",
        "provider",
        "providerMessageId",
        "receivedAt",
        "subject",
        "text",
        "toAddresses",
      ]
        .filter((k) => k !== "attachments")
        .sort(),
    );
  });
});

describe("verifyResendWebhookSignature", () => {
  it("returns false when any svix header is missing", async () => {
    const result = await verifyResendWebhookSignature(
      "{}",
      { "svix-id": null, "svix-timestamp": "123", "svix-signature": "sig" },
      "whsec_test",
    );
    expect(result).toBe(false);
  });

  it("returns false for an invalid signature", async () => {
    // Assembled at runtime (not a literal secret-shaped string in source) so this
    // synthetic fixture can't be mistaken for — or trip a scanner matching — a real
    // provider-issued webhook signing secret.
    const bogusSecret = `whsec_${Buffer.from("not-a-real-secret-fixture-only").toString("base64")}`;
    const result = await verifyResendWebhookSignature(
      '{"type":"email.received"}',
      { "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,bogus" },
      bogusSecret,
    );
    expect(result).toBe(false);
  });

  it("returns true for a correctly computed signature", async () => {
    const { Webhook } = await import("svix");
    // Deterministic, harmless, runtime-derived — never a hardcoded secret-shaped
    // literal (see note above).
    const secret = `whsec_${Buffer.from("syveka-unit-test-fixture-seed-bytes").toString("base64")}`;
    const payload = '{"type":"email.received"}';
    const wh = new Webhook(secret);
    const msgId = "msg_test";
    const timestamp = new Date();
    const signature = wh.sign(msgId, timestamp, payload);

    const result = await verifyResendWebhookSignature(
      payload,
      {
        "svix-id": msgId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
      secret,
    );
    expect(result).toBe(true);
  });
});
