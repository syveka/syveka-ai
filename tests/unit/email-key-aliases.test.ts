import { describe, expect, it } from "vitest";
import { emailKey } from "@/server/security/rate-limit";

// Per-recipient caps (public booking guests, invitations) are keyed by
// emailKey, so aliases of one mailbox must share a key.

describe("emailKey groups addresses that reach the same mailbox", () => {
  it.each([
    ["victim@example.test", "Victim@Example.TEST"],
    ["victim@example.test", "  victim@example.test "],
    ["victim@example.test", "victim+1@example.test"],
    ["victim@example.test", "victim+booking+2@example.test"],
    ["victim.name@gmail.com", "victimname@gmail.com"],
    ["v.i.c.t.i.m+x@gmail.com", "victim@gmail.com"],
    ["victim@googlemail.com", "victim@gmail.com"],
  ])("%s and %s share a key", (a, b) => {
    expect(emailKey(a)).toBe(emailKey(b));
  });

  it.each([
    ["victim@example.test", "other@example.test"],
    ["victim@example.test", "victim@example.org"],
    // Dots matter outside Gmail.
    ["victim.name@example.test", "victimname@example.test"],
  ])("%s and %s stay separate", (a, b) => {
    expect(emailKey(a)).not.toBe(emailKey(b));
  });

  it("never contains the address", () => {
    const key = emailKey("victim@example.test");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("victim");
  });

  it("an address that starts with + is kept whole", () => {
    expect(emailKey("+1@example.test")).not.toBe(emailKey("@example.test"));
  });
});
