import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/validate-staging-config.mjs");
const VALID_SOCIAL_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

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
  STAGING_CONFIG_MODE: "creator-studio",
  STAGING_FAL_API_KEY: "fal-test-key",
  STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY: VALID_SOCIAL_TOKEN_KEY,
};

describe("validate-staging-config.mjs: creator-studio mode", () => {
  it("passes when FAL + social token key are present and Meta is fully configured", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_META_APP_ID: "123456789",
      STAGING_META_APP_SECRET: "meta-secret",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Meta configured");
  });

  it("passes when FAL + social token key are present and Meta is entirely absent", () => {
    const result = run(BASE_ENV);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Instagram/Facebook publishing will fail closed at runtime");
    expect(result.stdout).toContain("image/video/caption generation is unaffected");
  });

  it("fails when only STAGING_META_APP_ID is set (missing the secret)", () => {
    const result = run({ ...BASE_ENV, STAGING_META_APP_ID: "123456789" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be configured together");
  });

  it("fails when only STAGING_META_APP_SECRET is set (missing the app id)", () => {
    const result = run({ ...BASE_ENV, STAGING_META_APP_SECRET: "meta-secret" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be configured together");
  });

  it("fails when STAGING_FAL_API_KEY is missing, regardless of Meta", () => {
    const result = run({
      STAGING_CONFIG_MODE: "creator-studio",
      STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY: VALID_SOCIAL_TOKEN_KEY,
      STAGING_META_APP_ID: "123456789",
      STAGING_META_APP_SECRET: "meta-secret",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STAGING_FAL_API_KEY");
  });

  it("fails when STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY is missing, regardless of Meta", () => {
    const result = run({
      STAGING_CONFIG_MODE: "creator-studio",
      STAGING_FAL_API_KEY: "fal-test-key",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY");
  });

  it("fails when a configured STAGING_META_APP_ID is not numeric", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_META_APP_ID: "not-a-number",
      STAGING_META_APP_SECRET: "meta-secret",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be a numeric Meta App ID");
  });

  it("fails when STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY is not 32 bytes base64", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SOCIAL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be 32 bytes, base64-encoded");
  });
});
