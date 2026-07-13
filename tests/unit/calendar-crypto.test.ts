import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken } from "@/server/integrations/calendar/crypto";

describe("OAuth token encryption (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips plaintext", () => {
    const secret = "ya29.a0AfH6SMBx-super-secret-token";
    const enc = encryptToken(secret);
    expect(enc).not.toContain(secret);
    expect(decryptToken(enc)).toBe(secret);
  });

  it("uses a fresh IV per encryption (no deterministic ciphertext)", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext (auth tag)", () => {
    const enc = encryptToken("secret");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    expect(() => decryptToken(buf.toString("base64"))).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => decryptToken("dG9vc2hvcnQ=")).toThrow();
  });

  it("requires a 32-byte key", () => {
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });

  it("fails loudly when the key is missing", () => {
    delete process.env.CALENDAR_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("x")).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY/);
  });
});
