import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(__dirname, "../../.github/workflows/staging-release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n?/g, "\n");

function stepBlock(stepName: string): string {
  const marker = `- name: ${stepName}`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Step "${stepName}" not found in staging-release.yml`);
  const nextStep = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? undefined : nextStep);
}

describe("staging-release.yml health-check retry budget", () => {
  it("gives cold Preview deployments a multi-minute retry budget, not the old fixed ~120s", () => {
    const block = stepBlock("Wait for staging health");
    const match = block.match(/max_attempts=(\d+)/);
    expect(match, "step must define max_attempts").not.toBeNull();
    const maxAttempts = Number(match![1]);
    // 3 consecutive runs timed out at the old 12-attempt/10s (~120s) budget while the
    // same deployment verified healthy moments later -- this asserts real headroom
    // beyond that, not just a token bump.
    expect(maxAttempts).toBeGreaterThanOrEqual(24);
  });

  it("bounds each individual request so one hung attempt can't consume the whole budget", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toMatch(/curl[^\n]*--max-time\s+\d+/s);
    expect(block).toMatch(/--connect-timeout\s+\d+/);
  });

  it("still requires an exact 200 to pass -- the health gate itself isn't weakened", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain('"$status" = "200"');
  });

  it("prints the observed status and sanitized body on every failed attempt", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toMatch(/echo\s+"Attempt \$attempt\/\$max_attempts: status=\$status/);
    expect(block).toContain(
      "Staging health check did not become healthy after $max_attempts attempts",
    );
  });

  it("keeps sending the bypass header against the exact per-run deployment URL", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain("x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("steps.staging-url.outputs.url");
    expect(block).not.toMatch(/echo\s+"?\$VERCEL_AUTOMATION_BYPASS_SECRET\b/);
  });

  it("does not request a bypass cookie -- run 30408486375 proved that forces an unfollowed 307 redirect", () => {
    const block = stepBlock("Wait for staging health");
    // The header name may still appear in an explanatory comment; only the actual
    // curl invocation (`-H "x-vercel-set-bypass-cookie...`) matters here.
    expect(block).not.toMatch(/-H\s+"x-vercel-set-bypass-cookie/);
  });

  it("captures the sanitized redirect Location (host+path, no query/nonce) for future diagnosability", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toMatch(/-D\s+"\$headers_file"/);
    expect(block).toMatch(/grep\s+-i\s+'\^location:'/);
    // Strips the query string so a Vercel SSO nonce never lands in CI logs.
    expect(block).toContain('location="${location%%\\?*}"');
  });

  describe("Location extraction survives set -euo pipefail on a no-Location response", () => {
    // Extracts the ACTUAL assignment lines from the workflow (not a hand-copied
    // duplicate that could drift out of sync) and executes them under bash with
    // set -euo pipefail, so this proves real runtime behavior of the deployed
    // script rather than just matching text in the YAML.
    function locationAssignmentSnippet(): string {
      const block = stepBlock("Wait for staging health");
      const startMarker = 'location="$(';
      const start = block.indexOf(startMarker);
      expect(start, 'location="$(...)" assignment not found').toBeGreaterThan(-1);
      const endMarker = 'location="${location%%\\?*}"';
      const endIdx = block.indexOf(endMarker, start);
      expect(endIdx, "location query-strip line not found").toBeGreaterThan(-1);
      return block.slice(start, endIdx + endMarker.length);
    }

    function runAgainstHeaders(headersFileContent: string): { exitCode: number; stdout: string } {
      const snippet = locationAssignmentSnippet();
      const headersFile = path.join(
        os.tmpdir(),
        `staging-health-headers-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      fs.writeFileSync(headersFile, headersFileContent);
      const script = `set -euo pipefail\nheaders_file="${headersFile}"\n${snippet}\necho "REACHED:[$location]"\n`;
      try {
        const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8" });
        return { exitCode: 0, stdout };
      } catch (error) {
        const err = error as { status: number | null; stdout?: string };
        return { exitCode: err.status ?? 1, stdout: err.stdout ?? "" };
      } finally {
        fs.rmSync(headersFile, { force: true });
      }
    }

    it("does not abort before the retry/logging line when the response has no Location header", () => {
      const headers = "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\n";
      const result = runAgainstHeaders(headers);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("REACHED:[]");
    });

    it("still extracts a real redirect Location and strips its query string", () => {
      const headers =
        "HTTP/1.1 307 Temporary Redirect\r\nlocation: https://example.com/login?nonce=abc123\r\n";
      const result = runAgainstHeaders(headers);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("REACHED:[https://example.com/login]");
    });
  });
});
