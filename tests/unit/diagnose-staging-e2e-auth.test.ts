import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/diagnose-staging-e2e-auth.mjs");
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
  STAGING_SUPABASE_ANON_KEY: "unused-in-these-cases",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "unused-in-these-cases",
  E2E_USER_EMAIL: "someone@example.test",
  E2E_USER_PASSWORD: "unused-in-these-cases",
};

describe("diagnose-staging-e2e-auth.mjs: fails closed before touching Prisma or Supabase", () => {
  it("rejects a Supabase URL for the wrong project", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: "https://some-other-project.supabase.co",
      DATABASE_URL: "postgresql://user:pass@db.some-other-project.supabase.co:5432/postgres",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match");
  });

  it("rejects a DATABASE_URL that doesn't identify the required project ref", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: `https://${REQUIRED_PROJECT_REF}.supabase.co`,
      DATABASE_URL: "postgresql://user:pass@db.some-other-project.supabase.co:5432/postgres",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not identify the required staging project ref");
  });

  it("fails with a clear message when a required env var is missing, and never echoes a password", () => {
    const result = run({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing required env var");
  });

  it("never prints raw credential values, even when the guard passes and it proceeds to a real (failing) Prisma connection", () => {
    const secretPassword = "super-secret-marker-value-should-never-appear";
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: `https://${REQUIRED_PROJECT_REF}.supabase.co`,
      DATABASE_URL: `postgresql://user:pass@db.${REQUIRED_PROJECT_REF}.supabase.co:5432/postgres`,
      E2E_USER_PASSWORD: secretPassword,
    });
    expect(result.stdout).not.toContain(secretPassword);
    expect(result.stderr).not.toContain(secretPassword);
  });
});

describe("diagnose-staging-e2e-auth.mjs: whitespace-shape reporting (only booleans/lengths, never raw values)", () => {
  it("reports whitespace shape without ever printing the value itself", () => {
    const result = run({
      ...BASE_ENV,
      STAGING_SUPABASE_URL: `https://${REQUIRED_PROJECT_REF}.supabase.co`,
      DATABASE_URL: `postgresql://user:pass@db.${REQUIRED_PROJECT_REF}.supabase.co:5432/postgres`,
      E2E_USER_PASSWORD: "  padded-with-whitespace  ",
    });
    expect(result.stdout).toContain('"hasLeadingOrTrailingWhitespace":true');
    expect(result.stdout).not.toContain("padded-with-whitespace");
  });
});
