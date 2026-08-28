import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { passwordFingerprint } from "@/server/db/credential-fingerprint";

describe("passwordFingerprint", () => {
  it("returns the SHA-256 hex digest of just the password segment", () => {
    const result = passwordFingerprint("postgresql://user:sUp3rSecret@host:5432/db");
    expect(result).toBe(createHash("sha256").update("sUp3rSecret").digest("hex"));
  });

  it("produces identical fingerprints for identical passwords on otherwise-different URLs", () => {
    const a = passwordFingerprint(
      "postgresql://alice:samePassword123@hostA:6543/db1?pgbouncer=true",
    );
    const b = passwordFingerprint("postgresql://bob:samePassword123@hostB:5432/db2");
    expect(a).toBe(b);
  });

  it("produces different fingerprints for different passwords", () => {
    const a = passwordFingerprint("postgresql://user:passwordOne@host:5432/db");
    const b = passwordFingerprint("postgresql://user:passwordTwo@host:5432/db");
    expect(a).not.toBe(b);
  });

  it("never includes the password itself in its output", () => {
    const secret = "sUp3r%24ecret%21Pass%23123"; // percent-encoded sUp3r$ecret!Pass#123
    const result = passwordFingerprint(`postgresql://user:${secret}@host:5432/db`);
    expect(result).not.toContain(secret);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
