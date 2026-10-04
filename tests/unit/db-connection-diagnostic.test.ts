import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConnection, logConnectionDiagnostic } from "@/server/db/connection-diagnostic";

// Synthetic values only. Refs are 20 lowercase alphanumerics, like real ones.
const PROD_REF = "prodrefaaaaaaaaaaaaa";
const OTHER_REF = "otherrefbbbbbbbbbbbb";
const PASSWORD = "S3cr3t-Pa55word";
const POOLER_HOST = "aws-1-eu-north-1.pooler.supabase.com";
const PROD_API_URL = `https://${PROD_REF}.supabase.co`;

const sharedPooler = (port: number, ref = PROD_REF, query = "") =>
  `postgresql://postgres.${ref}:${PASSWORD}@${POOLER_HOST}:${port}/postgres${query}`;
const dbHost = (port: number | null, ref = PROD_REF, query = "") =>
  `postgresql://postgres:${PASSWORD}@db.${ref}.supabase.co${port === null ? "" : `:${port}`}/postgres${query}`;

const prodContext = { supabaseUrl: PROD_API_URL, expectedProjectRef: PROD_REF };

// Everything that must never reach a log line.
const FORBIDDEN = [
  PASSWORD,
  PROD_REF,
  OTHER_REF,
  POOLER_HOST,
  "supabase.co",
  "postgres.",
  "verify-full",
  "pgbouncer",
  "connection_limit",
  "Invalid URL",
  "@",
];

function expectNoSecrets(output: string) {
  for (const fragment of FORBIDDEN) expect(output).not.toContain(fragment);
}

describe("describeConnection: endpoint classification", () => {
  it.each([
    ["shared pooler, transaction mode", sharedPooler(6543), "shared_pooler", 6543, "transaction"],
    ["shared pooler, session mode", sharedPooler(5432), "shared_pooler", 5432, "session"],
    [
      "dedicated pooler (transaction mode only)",
      dbHost(6543),
      "dedicated_pooler",
      6543,
      "transaction",
    ],
    ["direct connection", dbHost(5432), "direct", 5432, "session"],
  ])("%s", (_label, value, category, port, mode) => {
    const result = describeConnection(value, prodContext);
    expect(result).toMatchObject({
      variablePresent: true,
      endpointCategory: category,
      port,
      connectionMode: mode,
      expectedProjectMatch: "yes",
    });
    expectNoSecrets(JSON.stringify(result));
  });

  it("reports an absent variable without guessing anything else", () => {
    for (const value of [undefined, ""]) {
      expect(describeConnection(value, prodContext)).toEqual({
        variablePresent: false,
        endpointCategory: "unknown",
        port: "unknown",
        connectionMode: "unknown",
        expectedProjectMatch: "unknown",
        sslmodeParamPresent: "unknown",
      });
    }
  });

  it.each([
    ["not a URL", "definitely not a url"],
    ["unterminated IPv6 host", `postgresql://postgres:${PASSWORD}@[::1/postgres`],
    [
      "non-numeric port",
      `postgresql://postgres:${PASSWORD}@db.${PROD_REF}.supabase.co:abc/postgres`,
    ],
    ["wrong scheme", `https://postgres:${PASSWORD}@db.${PROD_REF}.supabase.co:5432/postgres`],
  ])("returns unknown for a malformed value (%s) without exposing it", (_label, value) => {
    const result = describeConnection(value, prodContext);
    expect(result).toEqual({
      variablePresent: true,
      endpointCategory: "unknown",
      port: "unknown",
      connectionMode: "unknown",
      expectedProjectMatch: "unknown",
      sslmodeParamPresent: "unknown",
    });
    expectNoSecrets(JSON.stringify(result));
  });

  it.each([
    ["db host with no port", dbHost(null), "unknown", "unknown", "unknown"],
    ["db host on an unexpected port", dbHost(5433), "unknown", 5433, "unknown"],
    [
      "shared pooler host on an unexpected port",
      sharedPooler(7000),
      "shared_pooler",
      7000,
      "unknown",
    ],
    [
      "lookalike host",
      `postgresql://postgres:${PASSWORD}@db.${PROD_REF}.supabase.co.example.com:6543/postgres`,
      "unknown",
      6543,
      "unknown",
    ],
    [
      "unrecognized pooler prefix",
      `postgresql://postgres.${PROD_REF}:${PASSWORD}@gcp-0-us-east1.pooler.supabase.com:6543/postgres`,
      "unknown",
      6543,
      "unknown",
    ],
    [
      "self-hosted database",
      `postgresql://app:${PASSWORD}@10.0.0.5:6543/app`,
      "unknown",
      6543,
      "unknown",
    ],
  ])("returns unknown for an ambiguous endpoint (%s)", (_label, value, category, port, mode) => {
    const result = describeConnection(value, prodContext);
    expect(result).toMatchObject({ endpointCategory: category, port, connectionMode: mode });
    expectNoSecrets(JSON.stringify(result));
  });

  it("reports whether an sslmode parameter is present, never its value", () => {
    const withSsl = describeConnection(
      sharedPooler(6543, PROD_REF, "?sslmode=verify-full"),
      prodContext,
    );
    const without = describeConnection(
      sharedPooler(6543, PROD_REF, "?pgbouncer=true"),
      prodContext,
    );
    expect(withSsl.sslmodeParamPresent).toBe(true);
    expect(without.sslmodeParamPresent).toBe(false);
    expectNoSecrets(JSON.stringify([withSsl, without]));
  });
});

describe("describeConnection: expected project match", () => {
  it("is 'yes' only when the database and the Supabase URL both match the expected ref", () => {
    expect(describeConnection(sharedPooler(6543), prodContext).expectedProjectMatch).toBe("yes");
  });

  it("is 'no' when the database points at another project", () => {
    expect(
      describeConnection(sharedPooler(6543, OTHER_REF), prodContext).expectedProjectMatch,
    ).toBe("no");
    expect(describeConnection(dbHost(6543, OTHER_REF), prodContext).expectedProjectMatch).toBe(
      "no",
    );
  });

  it("is 'no' when the Supabase URL points at another project, even if the database matches", () => {
    const context = {
      supabaseUrl: `https://${OTHER_REF}.supabase.co`,
      expectedProjectRef: PROD_REF,
    };
    expect(describeConnection(sharedPooler(6543), context).expectedProjectMatch).toBe("no");
  });

  it("is 'no' when the two variables agree with each other but not with the expected project", () => {
    const context = {
      supabaseUrl: `https://${OTHER_REF}.supabase.co`,
      expectedProjectRef: PROD_REF,
    };
    expect(describeConnection(sharedPooler(6543, OTHER_REF), context).expectedProjectMatch).toBe(
      "no",
    );
  });

  it("is 'unknown' without a valid expected ref, even when the two variables agree", () => {
    for (const expectedProjectRef of [undefined, "", "too-short", PROD_REF.toUpperCase()]) {
      const result = describeConnection(sharedPooler(6543), {
        supabaseUrl: PROD_API_URL,
        expectedProjectRef,
      });
      expect(result.expectedProjectMatch).toBe("unknown");
    }
  });

  it("is 'unknown' when a ref can't be determined and nothing contradicts the expected one", () => {
    // Custom API domain: the Supabase URL carries no ref.
    const customDomain = { supabaseUrl: "https://api.example.com", expectedProjectRef: PROD_REF };
    expect(describeConnection(sharedPooler(6543), customDomain).expectedProjectMatch).toBe(
      "unknown",
    );
    // Pooler username without a project suffix.
    const noSuffix = `postgresql://postgres:${PASSWORD}@${POOLER_HOST}:6543/postgres`;
    expect(describeConnection(noSuffix, prodContext).expectedProjectMatch).toBe("unknown");
    // Unrecognized endpoint.
    expect(
      describeConnection(`postgresql://app:${PASSWORD}@10.0.0.5:5432/app`, prodContext)
        .expectedProjectMatch,
    ).toBe("unknown");
  });
});

describe("logConnectionDiagnostic", () => {
  const ORIGINAL = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    expected: process.env.NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF,
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_API_URL;
    process.env.NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF = PROD_REF;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("NEXT_PUBLIC_SUPABASE_URL", ORIGINAL.supabaseUrl);
    restore("NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF", ORIGINAL.expected);
  });

  it("logs exactly one sanitized JSON line with only the reported fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logConnectionDiagnostic(sharedPooler(6543, PROD_REF, "?sslmode=require&pgbouncer=true"));

    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toEqual({
      event: "db_connection_diagnostic",
      variablePresent: true,
      endpointCategory: "shared_pooler",
      port: 6543,
      connectionMode: "transaction",
      expectedProjectMatch: "yes",
      sslmodeParamPresent: true,
    });
    expectNoSecrets(line);
  });

  it("never logs any part of a malformed value", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logConnectionDiagnostic(`postgresql://postgres:${PASSWORD}@[db.${PROD_REF}.supabase.co:6543`);

    expect(error).not.toHaveBeenCalled();
    expectNoSecrets(info.mock.calls.flat().join(" "));
  });

  it("never throws, even when logging itself fails", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(`log sink failed for ${PASSWORD}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logConnectionDiagnostic(sharedPooler(6543))).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});
