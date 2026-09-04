import { describe, expect, it, vi } from "vitest";
import { isTransientAuditFailure, runNpmAuditWithRetry } from "../../scripts/run-npm-audit";

// Fixtures reproduce the exact real-world output shapes this wrapper must tell apart.

const REAL_TRANSIENT_OUTAGE = [
  "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Service Unavailable",
  "{ error: 'Service Unavailable' }",
  "npm error audit endpoint returned an error",
  "npm error A complete log of this run can be found in: /home/runner/.npm/_logs/debug-0.log",
].join("\n");

const REAL_VULNERABILITY_FINDING = [
  "# npm audit report",
  "",
  "deepmerge-ts  <8.0.0",
  "Severity: high",
  "DeepmergeTS has stack exhaustion when merging recursive object graphs - https://github.com/advisories/GHSA-ggr8-5vv4-36mx",
  "fix available via `npm audit fix`",
  "node_modules/deepmerge-ts",
  "",
  "3 high severity vulnerabilities",
  "",
  "To address all issues, run:",
  "  npm audit fix",
].join("\n");

describe("isTransientAuditFailure", () => {
  it("recognizes a real 503 audit-endpoint outage", () => {
    expect(isTransientAuditFailure(REAL_TRANSIENT_OUTAGE)).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])(
    "recognizes an audit-endpoint error carrying HTTP %i",
    (status) => {
      const output = `npm warn audit ${status} Service Unavailable\nnpm error audit endpoint returned an error`;
      expect(isTransientAuditFailure(output)).toBe(true);
    },
  );

  it.each(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"])(
    "recognizes an audit-endpoint error carrying network code %s",
    (code) => {
      const output = `npm warn audit ${code}\nnpm error audit endpoint returned an error`;
      expect(isTransientAuditFailure(output)).toBe(true);
    },
  );

  it("does NOT treat a real vulnerability finding as transient", () => {
    expect(isTransientAuditFailure(REAL_VULNERABILITY_FINDING)).toBe(false);
  });

  it("does NOT treat an unrecognized npm failure as transient (fails closed by default)", () => {
    const output = "npm error code EUNKNOWN\nnpm error something else entirely broke";
    expect(isTransientAuditFailure(output)).toBe(false);
  });

  it("does NOT treat empty output as transient", () => {
    expect(isTransientAuditFailure("")).toBe(false);
  });

  it("requires BOTH the endpoint-error marker AND a transient status/code (not just a stray number)", () => {
    // A vulnerability report can itself mention unrelated numbers (CVE years, versions,
    // dependency counts); without the endpoint-error marker those must never trip this.
    const output = "# npm audit report\n\n3 high severity vulnerabilities in 500 packages";
    expect(isTransientAuditFailure(output)).toBe(false);
  });
});

interface FakeSpawnResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function fakeSpawn(results: FakeSpawnResult[]) {
  let call = 0;
  const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
    const result = results[Math.min(call, results.length - 1)]!;
    call += 1;
    return result;
  });
  return spawn;
}

describe("runNpmAuditWithRetry", () => {
  it("returns 0 immediately on a clean audit, with no retry", async () => {
    const spawn = fakeSpawn([{ status: 0, stdout: "found 0 vulnerabilities\n", stderr: "" }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
    });

    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("fails immediately on a real vulnerability finding, with no retry", async () => {
    const spawn = fakeSpawn([{ status: 1, stdout: REAL_VULNERABILITY_FINDING, stderr: "" }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
    });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("fails immediately on an unrecognized failure shape, with no retry", async () => {
    const spawn = fakeSpawn([{ status: 1, stdout: "", stderr: "npm error code EUNKNOWN" }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
    });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("fails immediately and diagnoses it clearly when npm itself cannot be launched", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawn = fakeSpawn([{ error: new Error("spawnSync npm ENOENT"), status: null }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
    });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to launch npm audit"),
    );
    consoleError.mockRestore();
  });

  it("passes shell:true to spawn only on Windows, matching production ubuntu-latest behavior otherwise", async () => {
    const spawn = fakeSpawn([{ status: 0, stdout: "", stderr: "" }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    await runNpmAuditWithRetry(["--audit-level=high"], { spawn, delay });

    const passedOptions = spawn.mock.calls[0]?.[2];
    expect(passedOptions?.shell).toBe(process.platform === "win32");
  });

  it("retries a transient outage and succeeds once the endpoint recovers", async () => {
    const spawn = fakeSpawn([
      { status: 1, stdout: "", stderr: REAL_TRANSIENT_OUTAGE },
      { status: 1, stdout: "", stderr: REAL_TRANSIENT_OUTAGE },
      { status: 0, stdout: "found 0 vulnerabilities\n", stderr: "" },
    ]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
    });

    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 5000);
    expect(delay).toHaveBeenNthCalledWith(2, 10000);
  });

  it("fails closed after exhausting retries on a persistent transient outage (never a silent pass)", async () => {
    const spawn = fakeSpawn([{ status: 1, stdout: "", stderr: REAL_TRANSIENT_OUTAGE }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    const exitCode = await runNpmAuditWithRetry(["--omit=dev", "--audit-level=high"], {
      spawn,
      delay,
      maxAttempts: 3,
    });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("passes the given npm audit arguments through unchanged", async () => {
    const spawn = fakeSpawn([{ status: 0, stdout: "", stderr: "" }]);
    const delay = vi.fn().mockResolvedValue(undefined);

    await runNpmAuditWithRetry(["--audit-level=high"], { spawn, delay });

    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["audit", "--audit-level=high"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });
});
