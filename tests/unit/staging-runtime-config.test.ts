import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(__dirname, "../../scripts/validate-staging-config.mjs");

/**
 * Runs the actual script (not just a text-containment check on its source)
 * to prove the "runtime" mode's project-ref cross-check genuinely rejects a
 * Vercel-pulled config that has drifted onto a different Supabase project
 * than the one the rest of staging-release just ran migrations/the E2E
 * fixture against -- not just that the check's code exists.
 */
function runValidateStagingConfig(env: Record<string, string>): { status: number; output: string } {
  try {
    const output = execFileSync("node", [scriptPath], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const baseRuntimeEnv = {
  STAGING_CONFIG_MODE: "runtime",
  STAGING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  NEXT_PUBLIC_APP_URL: "https://staging.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-placeholder",
  DATABASE_URL:
    "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0.pooler.supabase.com:6543/postgres",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-placeholder",
};

const script = fs.readFileSync(
  path.join(__dirname, "../../scripts/validate-staging-config.mjs"),
  "utf8",
);
const workflow = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/staging-release.yml"),
  "utf8",
);
const playwrightConfig = fs.readFileSync(
  path.join(__dirname, "../../playwright.config.ts"),
  "utf8",
);
const smoke = fs.readFileSync(path.join(__dirname, "../e2e/smoke.spec.ts"), "utf8");
const authSetup = fs.readFileSync(path.join(__dirname, "../e2e/auth.setup.ts"), "utf8");
const authHelper = fs.readFileSync(path.join(__dirname, "../e2e/helpers/auth.ts"), "utf8");

const coreRuntimeNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

describe("staging runtime configuration gate", () => {
  it("checks every core Vercel Preview setting name before building", () => {
    for (const name of coreRuntimeNames) expect(script).toContain(`"${name}"`);
    expect(workflow).toContain("STAGING_CONFIG_MODE=runtime");
    expect(workflow).toContain("--env-file=.vercel/.env.preview.local");
    expect(workflow.indexOf("STAGING_CONFIG_MODE=runtime")).toBeLessThan(
      workflow.indexOf('vercel@$VERCEL_CLI_VERSION" build'),
    );
  });

  it("does not require the migration-only DIRECT_URL in the Vercel runtime gate", () => {
    const runtimeBlock = script.slice(
      script.indexOf('mode === "runtime"'),
      script.indexOf('mode === "e2e"'),
    );
    expect(runtimeBlock).not.toContain("DIRECT_URL");
  });

  it("fails authenticated staging smoke setup instead of skipping it", () => {
    expect(workflow).toContain("Require authenticated staging E2E credentials");
    expect(workflow).toContain("secrets.STAGING_E2E_USER_EMAIL");
    expect(workflow).toContain("secrets.STAGING_E2E_USER_PASSWORD");
    expect(smoke).not.toContain("test.skip(!process.env.E2E_USER_EMAIL");
    expect(authSetup).toContain("requireE2EUserCredentials()");
    expect(authHelper).toContain("This spec requires E2E_USER_EMAIL and E2E_USER_PASSWORD.");
    expect(playwrightConfig).toContain('name: "auth-setup"');
    expect(playwrightConfig).toContain('dependencies: ["auth-setup"]');
    expect(playwrightConfig).toContain('storageState: "test-results/.auth/e2e-user.json"');
    expect(smoke).toContain("storageState: { cookies: [], origins: [] }");
  });

  describe("runtime mode project-ref verification (executes the real script)", () => {
    it("passes when the Vercel-pulled config matches the staging project ref", () => {
      const result = runValidateStagingConfig({
        ...baseRuntimeEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      });
      expect(result.status).toBe(0);
      expect(result.output).toContain("the deployed Supabase project matches staging");
    });

    it("rejects a Vercel-pulled NEXT_PUBLIC_SUPABASE_URL pointing at a different project", () => {
      const result = runValidateStagingConfig({
        ...baseRuntimeEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co",
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("does not match STAGING_SUPABASE_PROJECT_REF");
    });

    it("rejects a Vercel-pulled DATABASE_URL pointing at a different project", () => {
      const result = runValidateStagingConfig({
        ...baseRuntimeEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        DATABASE_URL:
          "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0.pooler.supabase.com:6543/postgres",
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("does not identify the staging Supabase project ref");
    });
  });

  /**
   * Reproduces a real staging-release failure: the Vercel-pulled DATABASE_URL
   * was not a parseable URL at all. The unwrapped `new URL()` call previously
   * used here throws a native TypeError whose `input` property (and adjacent
   * stack trace) is the raw value it failed to parse -- so the malformed
   * setting itself ended up printed into the CI log instead of a clean,
   * actionable error. These tests prove every URL-shaped setting in this
   * script now fails with only its field name, never its value.
   */
  describe("malformed URL settings never leak their raw value", () => {
    it("reports DATABASE_URL by name only when it is not a valid URL", () => {
      const result = runValidateStagingConfig({
        ...baseRuntimeEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        DATABASE_URL: "[SENSITIVE]",
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("DATABASE_URL is not a valid URL.");
      expect(result.output).not.toContain("[SENSITIVE]");
      expect(result.output).not.toContain("ERR_INVALID_URL");
    });

    it("reports NEXT_PUBLIC_SUPABASE_URL by name only when it is not a valid URL", () => {
      const result = runValidateStagingConfig({
        ...baseRuntimeEnv,
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
      expect(result.output).not.toContain("not-a-url");
      expect(result.output).not.toContain("ERR_INVALID_URL");
    });

    it("reports STAGING_SUPABASE_URL by name only in identity mode when it is not a valid URL", () => {
      const result = runValidateStagingConfig({
        STAGING_CONFIG_MODE: "identity",
        STAGING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
        PRODUCTION_SUPABASE_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz",
        STAGING_SUPABASE_URL: "[SENSITIVE]",
        STAGING_DATABASE_URL:
          "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0.pooler.supabase.com:6543/postgres",
        STAGING_DIRECT_URL:
          "postgresql://postgres.abcdefghijklmnopqrst:pw@db.example.com:5432/postgres",
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("STAGING_SUPABASE_URL is not a valid URL.");
      expect(result.output).not.toContain("[SENSITIVE]");
      expect(result.output).not.toContain("ERR_INVALID_URL");
    });
  });
});
