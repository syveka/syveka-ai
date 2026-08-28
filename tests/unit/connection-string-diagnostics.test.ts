import { describe, expect, it } from "vitest";
import { classifyDbUrl } from "@/server/db/connection-string-diagnostics";

describe("classifyDbUrl", () => {
  it("classifies a well-formed transaction-pooler URL with pgbouncer params", () => {
    const result = classifyDbUrl(
      "postgresql://postgres.abcdefghijk:correcthorse@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
    );

    expect(result.parsed).toBe(true);
    expect(result.hostClass).toBe("transaction-pooler");
    expect(result.port).toBe("6543");
    expect(result.usernameLooksLikeSupabasePooled).toBe(true);
    expect(result.hasPassword).toBe(true);
    expect(result.hasDatabaseName).toBe(true);
    expect(result.queryParamNames).toEqual(["pgbouncer", "connection_limit"]);
    expect(result.questionMarkCount).toBe(1);
    expect(result.hasLeadingOrTrailingWhitespace).toBe(false);
  });

  it("classifies a session-pooler URL (port 5432 on the pooler host)", () => {
    const result = classifyDbUrl(
      "postgresql://postgres.abcdefghijk:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
    );
    expect(result.hostClass).toBe("session-pooler");
  });

  it("classifies a direct db.<ref>.supabase.co host", () => {
    const result = classifyDbUrl(
      "postgresql://postgres:pw@db.abcdefghijk.supabase.co:5432/postgres",
    );
    expect(result.hostClass).toBe("direct");
    expect(result.usernameLooksLikeSupabasePooled).toBe(true);
  });

  it("detects a second literal '?' appended instead of '&' before extra params", () => {
    const raw =
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true?connection_limit=1";
    const result = classifyDbUrl(raw);
    expect(result.questionMarkCount).toBe(2);
    // A second literal `?` is treated as a literal query-string character by
    // the URL parser, not a new parameter separator — so the second
    // "parameter" never becomes its own query key.
    expect(result.queryParamNames).not.toContain("connection_limit");
  });

  it("flags leading/trailing whitespace from a pasted value", () => {
    const result = classifyDbUrl(
      "  postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres  ",
    );
    expect(result.hasLeadingOrTrailingWhitespace).toBe(true);
    // trimmed before parsing, so it still parses successfully
    expect(result.parsed).toBe(true);
  });

  it("flags an embedded newline from a multi-line paste", () => {
    const result = classifyDbUrl(
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres\n",
    );
    expect(result.containsNewlineOrCarriageReturn).toBe(true);
  });

  it("flags a literal quote character left over from copying a quoted .env value", () => {
    const result = classifyDbUrl(
      '"postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres"',
    );
    expect(result.containsLiteralQuoteChar).toBe(true);
    // the surrounding quotes make this an invalid URL to the WHATWG parser
    expect(result.parsed).toBe(false);
    expect(result.parseErrorName).toBeDefined();
  });

  it("reports parsed:false with no crash for a completely malformed value", () => {
    const result = classifyDbUrl("not-a-url-at-all");
    expect(result.parsed).toBe(false);
    expect(result.parseErrorName).toBeDefined();
  });

  it("reports parsed:false with no crash when the value is undefined", () => {
    const result = classifyDbUrl(undefined);
    expect(result.parsed).toBe(false);
    expect(result.hasPassword).toBe(false);
  });

  it("never includes the password in any field it returns", () => {
    const secret = "sUp3r$ecret!Pass#123";
    const result = classifyDbUrl(
      `postgresql://postgres.abc:${secret}@aws-0-eu-north-1.pooler.supabase.com:6543/postgres`,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });
});
