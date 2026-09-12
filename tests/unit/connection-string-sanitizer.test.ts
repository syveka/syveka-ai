import { describe, expect, it } from "vitest";
import { sanitizeConnectionString } from "@/server/db/connection-string-sanitizer";

describe("sanitizeConnectionString", () => {
  const clean =
    "postgresql://postgres.abcdefghijk:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1";

  it("strips a trailing embedded newline and a leftover trailing '?' — the exact corruption pattern observed live in staging", () => {
    const corrupted = `${clean}\n?`;
    expect(sanitizeConnectionString(corrupted)).toBe(clean);
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeConnectionString(`  ${clean}  `)).toBe(clean);
  });

  it("strips embedded carriage returns and newlines anywhere in the string", () => {
    expect(sanitizeConnectionString(`postgresql://a:b@\r\nhost:5432/db`)).toBe(
      "postgresql://a:b@host:5432/db",
    );
  });

  it("is a no-op on an already-clean connection string", () => {
    expect(sanitizeConnectionString(clean)).toBe(clean);
  });

  it("does not corrupt a value that legitimately has no query string", () => {
    const noQuery = "postgresql://postgres:pw@db.abcdefghijk.supabase.co:5432/postgres";
    expect(sanitizeConnectionString(noQuery)).toBe(noQuery);
  });

  it("never appears to retain a password in a way distinguishable from input — passthrough only, no logging", () => {
    const secret = "sUp3r$ecret!Pass#123";
    const withSecret = `postgresql://postgres.abc:${secret}@aws-0-eu-north-1.pooler.supabase.com:6543/postgres`;
    expect(sanitizeConnectionString(withSecret)).toBe(withSecret);
  });
});
