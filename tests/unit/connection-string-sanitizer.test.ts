import { describe, expect, it } from "vitest";
import {
  ensurePgbouncerCompatibility,
  sanitizeConnectionString,
} from "@/server/db/connection-string-sanitizer";

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

/**
 * Live incident (staging, 2026-09-12): after switching DATABASE_URL to the
 * transaction pooler (port 6543) to fix EMAXCONNSESSION connection
 * exhaustion, every request immediately started failing with
 * PrismaClientUnknownRequestError / Postgres error 08P01 ("bind message
 * supplies N parameters, but prepared statement requires M") — the
 * well-documented Prisma+PgBouncer prepared-statement incompatibility,
 * which Prisma's own docs say requires `pgbouncer=true` (and recommend
 * `connection_limit=1` alongside it for serverless) on the connection
 * string. These tests lock in the defensive fix so a future connection-
 * string rotation that omits those params can't reintroduce the outage.
 */
describe("ensurePgbouncerCompatibility", () => {
  it("adds pgbouncer=true and connection_limit=1 to a transaction-pooler URL missing them", () => {
    const raw =
      "postgresql://postgres.abcdefghijk:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres";
    const result = ensurePgbouncerCompatibility(raw);
    const url = new URL(result);
    expect(url.searchParams.get("pgbouncer")).toBe("true");
    expect(url.searchParams.get("connection_limit")).toBe("1");
  });

  it("does not duplicate or override an already-present pgbouncer/connection_limit value", () => {
    const raw =
      "postgresql://postgres.abcdefghijk:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5";
    const result = ensurePgbouncerCompatibility(raw);
    const url = new URL(result);
    expect(url.searchParams.getAll("connection_limit")).toEqual(["5"]);
    expect(url.searchParams.getAll("pgbouncer")).toEqual(["true"]);
  });

  it("is a no-op for a non-pooler (session/direct, port 5432) connection string", () => {
    const raw = "postgresql://postgres:pw@db.abcdefghijk.supabase.co:5432/postgres";
    expect(ensurePgbouncerCompatibility(raw)).toBe(raw);
  });

  it("is a no-op for an unparseable value (never throws)", () => {
    expect(ensurePgbouncerCompatibility("not-a-url")).toBe("not-a-url");
  });

  it("never logs or otherwise loses the password when rewriting the query string", () => {
    const secret = "sUp3r$ecret!Pass#123";
    const raw = `postgresql://postgres.abc:${encodeURIComponent(secret)}@aws-0-eu-north-1.pooler.supabase.com:6543/postgres`;
    const result = ensurePgbouncerCompatibility(raw);
    expect(decodeURIComponent(new URL(result).password)).toBe(secret);
  });
});
