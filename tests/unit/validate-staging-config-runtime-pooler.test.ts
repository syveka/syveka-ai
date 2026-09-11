import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/validate-staging-config.mjs");
const PROJECT_REF = "badkselmhtqglbnszsbz";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string | undefined>): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const BASE_ENV = {
  STAGING_CONFIG_MODE: "runtime",
  STAGING_SUPABASE_PROJECT_REF: PROJECT_REF,
  NEXT_PUBLIC_APP_URL: "https://staging.example.test",
  NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-token",
};

/**
 * SKIPPED, not deleted: this locks in the fix for a live incident (staging
 * deployment syveka-ai-staging-g8hefermc-syveka-ai.vercel.app threw
 * PrismaClientInitializationError under concurrent Playwright load --
 * "FATAL: (EMAXCONNSESSION) max clients reached in session mode - max
 * clients are limited to pool_size: 15") but the companion fix to
 * scripts/validate-staging-config.mjs itself could not be committed tonight
 * -- that file is a protected, CI-verification-critical config file per
 * this repo's guardrail, and applying the fix requires a human to either
 * set SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 or apply the diff directly (see
 * docs/staging-database-url-pooler-fix.md for the exact patch).
 *
 * Once that diff is applied, remove `.skip` here -- every case below was
 * independently verified tonight against the proposed script content
 * before this file was committed, so they are expected to pass immediately.
 */
describe.skip("validate-staging-config.mjs: runtime mode rejects a session-mode/direct DATABASE_URL", () => {
  it("fails when DATABASE_URL uses the session-mode pooler port (5432)", () => {
    const result = run({
      ...BASE_ENV,
      DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:pw@aws-0-eu.pooler.supabase.com:5432/postgres`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not Supabase's transaction-mode pooler port 6543");
  });

  it("fails when DATABASE_URL has no explicit port (defaults to 5432)", () => {
    const result = run({
      ...BASE_ENV,
      DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:pw@db.${PROJECT_REF}.supabase.co/postgres`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uses port 5432");
  });

  it("passes when DATABASE_URL uses the transaction-mode pooler port (6543)", () => {
    const result = run({
      ...BASE_ENV,
      DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:pw@aws-0-eu.pooler.supabase.com:6543/postgres`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Required staging runtime setting names are present");
  });

  it("never prints the DATABASE_URL value itself, only the port number", () => {
    const result = run({
      ...BASE_ENV,
      DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:super-secret-password@aws-0-eu.pooler.supabase.com:5432/postgres`,
    });
    expect(result.stderr).not.toContain("super-secret-password");
    expect(result.stdout).not.toContain("super-secret-password");
  });
});
