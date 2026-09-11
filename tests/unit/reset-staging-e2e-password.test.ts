import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/reset-staging-e2e-password.mjs");
const REQUIRED_PROJECT_REF = "badkselmhtqglbnszsbz";

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
  REQUIRED_PROJECT_REF,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "unused-in-these-cases",
  PASSWORD_OUTPUT_FILE: "/tmp/unused-in-these-cases.txt",
};

describe("reset-staging-e2e-password.mjs: fails closed before touching Prisma or Supabase", () => {
  it("rejects a Supabase URL for the wrong project, without needing a real DATABASE_URL", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: "https://some-other-project.supabase.co",
      DATABASE_URL: "postgresql://user:pass@db.some-other-project.supabase.co:5432/postgres",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STAGING_SUPABASE_URL host");
    expect(result.stderr).toContain("does not match the required staging project ref");
  });

  it("rejects a DATABASE_URL that doesn't identify the required project ref", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: `https://${REQUIRED_PROJECT_REF}.supabase.co`,
      DATABASE_URL: "postgresql://user:pass@db.some-other-project.supabase.co:5432/postgres",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DATABASE_URL does not identify the required staging project ref",
    );
  });

  it("rejects a malformed STAGING_SUPABASE_URL", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: "not-a-url",
      DATABASE_URL: `postgresql://user:pass@db.${REQUIRED_PROJECT_REF}.supabase.co:5432/postgres`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STAGING_SUPABASE_URL is not a valid URL");
  });

  it("fails with a clear message when a required env var is missing", () => {
    const result = run({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing required env var");
  });

  it("accepts a matching project ref/URL pair and proceeds past the guard (fails later, on the real Prisma connection)", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: `https://${REQUIRED_PROJECT_REF}.supabase.co`,
      DATABASE_URL: `postgresql://user:pass@db.${REQUIRED_PROJECT_REF}.supabase.co:5432/postgres`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("does not match the required staging project ref");
    expect(result.stderr).not.toContain("does not identify the required staging project ref");
  });
});
