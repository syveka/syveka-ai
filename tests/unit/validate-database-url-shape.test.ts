import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Built after staging run 33961238272 failed with
 * `FATAL: database "postgres\n" does not exist` -- a trailing newline
 * embedded in the STAGING_DIRECT_URL secret's value. Spawned as a subprocess
 * (not imported directly) matching the convention
 * tests/unit/legacy-schema-contract-generator.test.ts already established
 * for testing standalone scripts/*.mjs files as black boxes.
 */
const SCRIPT_PATH = resolve(process.cwd(), "scripts/validate-database-url-shape.mjs");
const FAKE_PASSWORD = "fakepassword123";
const STAGING_REF = "badkselmhtqglbnszsbz";
const PRODUCTION_REF = "lpjihoghnsrzelbzhxko";

function run(value: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "TEST_URL", ...args], {
    env: { ...process.env, TEST_URL: value },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("validate-database-url-shape", () => {
  it("PASS: correct direct staging URL shape", () => {
    const { status, stdout } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@db.${STAGING_REF}.supabase.co:5432/postgres`,
      [`--expect-ref=${STAGING_REF}`],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("passed shape validation");
  });

  it("PASS: correct session-pooler staging URL shape", () => {
    const { status, stdout } = run(
      `postgresql://postgres.${STAGING_REF}:${FAKE_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      [`--expect-ref=${STAGING_REF}`],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("passed shape validation");
  });

  it("FAIL: exact reproduction of staging run 33961238272 -- trailing newline", () => {
    const { status, stderr } = run(
      `postgresql://postgres.${STAGING_REF}:${FAKE_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres\n`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("leading or trailing whitespace");
  });

  it("FAIL: leading whitespace", () => {
    const { status, stderr } = run(
      ` postgresql://postgres:${FAKE_PASSWORD}@db.${STAGING_REF}.supabase.co:5432/postgres`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("leading or trailing whitespace");
  });

  it("FAIL: pooler host with bare 'postgres' username", () => {
    const { status, stderr } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Supavisor-format username");
  });

  it("FAIL: pooler host with wrong project ref (via --expect-ref)", () => {
    const { status, stderr } = run(
      `postgresql://postgres.${PRODUCTION_REF}:${FAKE_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      [`--expect-ref=${STAGING_REF}`],
    );
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the expected staging project ref");
  });

  it("FAIL: direct host with wrong project ref (via --expect-ref)", () => {
    const { status, stderr } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@db.${PRODUCTION_REF}.supabase.co:5432/postgres`,
      [`--expect-ref=${STAGING_REF}`],
    );
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the expected staging project ref");
  });

  it("FAIL: database path is not 'postgres'", () => {
    const { status, stderr } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@db.${STAGING_REF}.supabase.co:5432/wrong_db`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('must be exactly "postgres"');
  });

  it("FAIL: missing password", () => {
    const { status, stderr } = run(
      `postgresql://postgres@db.${STAGING_REF}.supabase.co:5432/postgres`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("password is empty");
  });

  it("FAIL: malformed URL", () => {
    const { status, stderr } = run("not-a-url-at-all");
    expect(status).toBe(1);
    expect(stderr).toContain("not a parseable URL");
  });

  it("FAIL: unexpected host (neither direct nor pooler)", () => {
    const { status, stderr } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@example.com:5432/postgres`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("matches neither a direct Supabase host");
  });

  it("FAIL: production project ref explicitly forbidden", () => {
    const { status, stderr } = run(
      `postgresql://postgres:${FAKE_PASSWORD}@db.${PRODUCTION_REF}.supabase.co:5432/postgres`,
      [`--forbid-ref=${PRODUCTION_REF}`],
    );
    expect(status).toBe(1);
    expect(stderr).toContain("forbidden (production) project ref");
  });

  it("FAIL: wrong port for pooler mode (transaction pooler, 6543)", () => {
    const { status, stderr } = run(
      `postgresql://postgres.${STAGING_REF}:${FAKE_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("transaction pooler");
  });

  it("redaction: never prints the raw password, in stdout or stderr, on pass or fail", () => {
    const passing = run(
      `postgresql://postgres:${FAKE_PASSWORD}@db.${STAGING_REF}.supabase.co:5432/postgres`,
    );
    expect(passing.stdout).not.toContain(FAKE_PASSWORD);
    expect(passing.stderr).not.toContain(FAKE_PASSWORD);

    const failing = run(`postgresql://postgres:${FAKE_PASSWORD}@example.com:5432/postgres`);
    expect(failing.stdout).not.toContain(FAKE_PASSWORD);
    expect(failing.stderr).not.toContain(FAKE_PASSWORD);
  });

  it("redaction: never prints the full raw URL", () => {
    const url = `postgresql://postgres:${FAKE_PASSWORD}@db.${STAGING_REF}.supabase.co:5432/postgres`;
    const { stdout, stderr } = run(url);
    expect(stdout).not.toContain(url);
    expect(stderr).not.toContain(url);
  });

  it("errors clearly when the env var is unset", () => {
    const env = { ...process.env };
    delete env.SOME_UNSET_VAR;
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "SOME_UNSET_VAR"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not set");
  });
});
