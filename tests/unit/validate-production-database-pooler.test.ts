import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/validate-production-database-pooler.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runAsScript(databaseUrl: string | undefined): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl } as NodeJS.ProcessEnv,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("validate-production-database-pooler.mjs", () => {
  it("exits 0 and logs success when DATABASE_URL is port 6543", () => {
    const result = runAsScript(
      "postgresql://postgres.ref:pw@aws-0-eu.pooler.supabase.com:6543/postgres",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("transaction-mode pooler (port 6543)");
  });

  it("exits non-zero and never prints the connection string when DATABASE_URL is the session-mode pooler port (5432)", () => {
    const result = runAsScript(
      "postgresql://postgres.ref:super-secret-password@aws-0-eu.pooler.supabase.com:5432/postgres",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uses port 5432");
    expect(result.stderr).toContain("not Supabase's transaction-mode pooler port 6543");
    expect(result.stderr).not.toContain("super-secret-password");
    expect(result.stdout).not.toContain("super-secret-password");
  });

  it("exits non-zero and reports port 5432 when DATABASE_URL has no explicit port", () => {
    const result = runAsScript(
      "postgresql://postgres.ref:super-secret-password@db.ref.supabase.co/postgres",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uses port 5432");
    expect(result.stderr).not.toContain("super-secret-password");
    expect(result.stderr).not.toContain("db.ref.supabase.co");
  });

  it("exits non-zero with a clear message when DATABASE_URL is entirely unset", () => {
    const result = runAsScript(undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });
});
